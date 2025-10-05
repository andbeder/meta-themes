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

async function querySalesforceRecords(accessToken, instanceUrl, objectName, fields, filterField, filterValues) {
  // Create IN clause for filtering
  const filterClause = filterValues.map(value => `'${value}'`).join(',');
  const fieldList = ['Id', ...fields, filterField].join(', ');
  const query = `SELECT ${fieldList} FROM ${objectName} WHERE ${filterField} IN (${filterClause}) LIMIT 200`;
  const url = `${instanceUrl}/services/data/v58.0/query`;

  try {
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        q: query
      }
    });

    return response.data.records || [];
  } catch (error) {
    if (error.response) {
      throw new Error(`Salesforce API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Network error: ${error.message}`);
  }
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

module.exports = { main, readCsvFile, getFieldMetadata, combineFieldsWithLabels, querySalesforceRecords, sendToLMStudio, writeResultsToCSV };