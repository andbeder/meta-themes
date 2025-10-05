#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createObjectCsvWriter } = require('csv-writer');
const csv = require('csv-parser');
const authorize = require('./sfdcJwtAuth');

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 4) {
    console.error('Usage: node index.js <salesforce-object> <field-names> <prompt> <csv-file>');
    console.error('Example: node index.js Employee_Survey_Response__c Q6_Recognition_Thoughts__c "Extract meta-themes from this survey response" survey-ids.csv');
    console.error('Multiple fields: node index.js Employee_Survey_Response__c Q6_Recognition_Thoughts__c,Q4_Supervisor_Skills__c "Extract meta-themes" survey-ids.csv');
    process.exit(1);
  }

  const [objectName, fieldNames, prompt, csvFile] = args;
  const fields = fieldNames.split(',').map(field => field.trim());

  console.log(`Scanning Salesforce object: ${objectName}`);
  console.log(`Reading fields: ${fields.join(', ')}`);
  console.log(`Using prompt: "${prompt}"`);
  console.log(`Using CSV file: ${csvFile}`);

  try {
    // Read CSV file to get filter data
    console.log('Reading CSV file...');
    const { filterField, filterValues } = await readCsvFile(csvFile);
    console.log(`Filter field: ${filterField}`);
    console.log(`Found ${filterValues.length} values to filter by`);

    // Authenticate to Salesforce
    console.log('Authenticating to Salesforce...');
    const { accessToken, instanceUrl } = await authorize();

    // Get field metadata
    console.log('Retrieving field metadata...');
    const fieldMetadata = await getFieldMetadata(accessToken, instanceUrl, objectName, fields);

    // Query Salesforce records
    console.log('Querying Salesforce records...');
    const records = await querySalesforceRecords(accessToken, instanceUrl, objectName, fields, filterField, filterValues);

    console.log(`Found ${records.length} records`);

    // Process records with LM Studio
    console.log('Processing records with LM Studio...');
    const results = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      console.log(`Processing record ${i + 1}/${records.length}: ${record.Id}`);

      const combinedText = combineFieldsWithLabels(record, fields, fieldMetadata);
      if (combinedText.trim()) {
        try {
          const response = await sendToLMStudio(prompt, combinedText);
          results.push({
            recordId: record.Id,
            [filterField]: record[filterField],
            originalText: combinedText,
            response: response
          });
        } catch (error) {
          console.error(`Error processing record ${record.Id}:`, error.message);
          results.push({
            recordId: record.Id,
            [filterField]: record[filterField],
            originalText: combinedText,
            response: `Error: ${error.message}`
          });
        }
      } else {
        console.log(`Skipping record ${record.Id} - all specified fields are empty`);
      }
    }

    // Write results to CSV
    const outputFile = `${objectName}_${fields.join('_')}_results.csv`;
    await writeResultsToCSV(results, outputFile, filterField);

    console.log(`Results written to ${outputFile}`);
    console.log(`Processed ${results.length} records successfully`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function readCsvFile(csvFilePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    let filterField = null;

    fs.createReadStream(csvFilePath)
      .pipe(csv({
        skipEmptyLines: true,
        stripBOM: true  // This removes the BOM character
      }))
      .on('headers', (headers) => {
        // Clean the header to remove any BOM or whitespace
        filterField = headers[0].replace(/^\uFEFF/, '').trim();
      })
      .on('data', (data) => {
        const firstKey = Object.keys(data)[0];
        const value = data[firstKey];
        if (value && value.trim()) {
          // Clean the value to remove any BOM or extra whitespace
          results.push(value.replace(/^\uFEFF/, '').trim());
        }
      })
      .on('end', () => {
        resolve({ filterField, filterValues: results });
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

async function getFieldMetadata(accessToken, instanceUrl, objectName, fields) {
  const url = `${instanceUrl}/services/data/v58.0/sobjects/${objectName}/describe`;

  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    const fieldMap = {};
    response.data.fields.forEach(field => {
      if (fields.includes(field.name)) {
        fieldMap[field.name] = {
          label: field.label,
          name: field.name
        };
      }
    });

    return fieldMap;
  } catch (error) {
    if (error.response) {
      throw new Error(`Salesforce Metadata API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Network error: ${error.message}`);
  }
}

function combineFieldsWithLabels(record, fields, fieldMetadata) {
  const parts = [];

  fields.forEach(fieldName => {
    if (record[fieldName] && record[fieldName].trim()) {
      const label = fieldMetadata[fieldName]?.label || fieldName;
      parts.push(`${label}: ${record[fieldName].trim()}`);
    }
  });

  return parts.join('\n\n');
}

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

async function querySalesforceRecordsChunk(accessToken, instanceUrl, objectName, fields, filterField, filterValuesChunk, chunkIndex, totalChunks) {
  const allRecords = [];
  let totalRecords = 0;
  let pageCount = 0;

  // Create IN clause for filtering this chunk
  const filterClause = filterValuesChunk.map(value => `'${value}'`).join(',');
  const fieldList = ['Id', ...fields, filterField].join(', ');
  const query = `SELECT ${fieldList} FROM ${objectName} WHERE ${filterField} IN (${filterClause}) ORDER BY Id`;

  let nextRecordsUrl = null;
  let isFirstQuery = true;

  try {
    do {
      pageCount++;
      let url, params;

      if (isFirstQuery) {
        // First query with LIMIT
        url = `${instanceUrl}/services/data/v58.0/query`;
        params = { q: `${query} LIMIT 200` };
        isFirstQuery = false;
      } else {
        // Subsequent queries using nextRecordsUrl
        url = `${instanceUrl}${nextRecordsUrl}`;
        params = {};
      }

      console.log(`  Chunk ${chunkIndex}/${totalChunks}, Page ${pageCount}: Fetching...`);

      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        params: params
      });

      const data = response.data;
      const records = data.records || [];

      allRecords.push(...records);
      totalRecords += records.length;

      console.log(`  Chunk ${chunkIndex}/${totalChunks}, Page ${pageCount}: Retrieved ${records.length} records (Chunk Total: ${totalRecords})`);

      // Check if there are more records
      nextRecordsUrl = data.nextRecordsUrl || null;

      // Safety check to prevent infinite loops
      if (pageCount > 100) {
        console.warn(`  Warning: Reached maximum page limit (100) for chunk ${chunkIndex}. Stopping pagination.`);
        break;
      }

    } while (nextRecordsUrl);

    console.log(`  Chunk ${chunkIndex}/${totalChunks} complete: ${totalRecords} records retrieved in ${pageCount} pages`);
    return allRecords;

  } catch (error) {
    if (error.response) {
      throw new Error(`Salesforce API error (Chunk ${chunkIndex}): ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Network error (Chunk ${chunkIndex}): ${error.message}`);
  }
}

async function querySalesforceRecords(accessToken, instanceUrl, objectName, fields, filterField, filterValues) {
  const CHUNK_SIZE = 450; // Stay well under 500 limit for safety

  // Check if we need to chunk the filter values
  if (filterValues.length <= CHUNK_SIZE) {
    console.log(`  Single query: ${filterValues.length} filter values (under ${CHUNK_SIZE} limit)`);
    return await querySalesforceRecordsChunk(accessToken, instanceUrl, objectName, fields, filterField, filterValues, 1, 1);
  }

  // Split filter values into chunks
  const chunks = chunkArray(filterValues, CHUNK_SIZE);
  console.log(`  Chunking required: ${filterValues.length} filter values split into ${chunks.length} chunks of max ${CHUNK_SIZE}`);

  const allRecords = [];
  let totalRecords = 0;

  // Process each chunk
  for (let i = 0; i < chunks.length; i++) {
    const chunkRecords = await querySalesforceRecordsChunk(
      accessToken,
      instanceUrl,
      objectName,
      fields,
      filterField,
      chunks[i],
      i + 1,
      chunks.length
    );

    allRecords.push(...chunkRecords);
    totalRecords += chunkRecords.length;

    // Add a small delay between chunks to be nice to the API
    if (i < chunks.length - 1) {
      console.log(`  Waiting 1 second before next chunk...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  console.log(`  All chunks complete: ${totalRecords} total records retrieved from ${chunks.length} chunks`);
  return allRecords;
}

async function sendToLMStudio(prompt, text) {
  const lmStudioUrl = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1/chat/completions';

  const requestBody = {
    model: "local-model", // LM Studio typically uses this or you can specify the actual model name
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nText to analyze: ${text}`
      }
    ],
    temperature: 0.7,
    max_tokens: 500
  };

  try {
    const response = await axios.post(lmStudioUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 30000 // 30 second timeout
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    if (error.response) {
      throw new Error(`LM Studio API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`LM Studio connection error: ${error.message}`);
  }
}

async function writeResultsToCSV(results, filename, filterField) {
  const csvWriter = createObjectCsvWriter({
    path: filename,
    header: [
      { id: 'recordId', title: 'Salesforce Record ID' },
      { id: filterField, title: filterField },
      { id: 'originalText', title: 'Original Text' },
      { id: 'response', title: 'LM Studio Response' }
    ]
  });

  await csvWriter.writeRecords(results);
}

if (require.main === module) {
  main();
}

module.exports = { main, readCsvFile, getFieldMetadata, combineFieldsWithLabels, chunkArray, querySalesforceRecordsChunk, querySalesforceRecords, sendToLMStudio, writeResultsToCSV };