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
    console.error('Usage: node index.js <salesforce-object> <field-name> <prompt> <csv-file>');
    console.error('Example: node index.js Employee_Survey_Response__c Q6 "Extract meta-themes from this survey response" survey-ids.csv');
    process.exit(1);
  }

  const [objectName, fieldName, prompt, csvFile] = args;

  console.log(`Scanning Salesforce object: ${objectName}`);
  console.log(`Reading field: ${fieldName}`);
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

    // Query Salesforce records
    console.log('Querying Salesforce records...');
    const records = await querySalesforceRecords(accessToken, instanceUrl, objectName, fieldName, filterField, filterValues);

    console.log(`Found ${records.length} records`);

    // Process records with LM Studio
    console.log('Processing records with LM Studio...');
    const results = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      console.log(`Processing record ${i + 1}/${records.length}: ${record.Id}`);

      if (record[fieldName]) {
        try {
          const response = await sendToLMStudio(prompt, record[fieldName]);
          results.push({
            recordId: record.Id,
            [filterField]: record[filterField],
            originalText: record[fieldName],
            response: response
          });
        } catch (error) {
          console.error(`Error processing record ${record.Id}:`, error.message);
          results.push({
            recordId: record.Id,
            [filterField]: record[filterField],
            originalText: record[fieldName],
            response: `Error: ${error.message}`
          });
        }
      } else {
        console.log(`Skipping record ${record.Id} - field ${fieldName} is empty`);
      }
    }

    // Write results to CSV
    const outputFile = `${objectName}_${fieldName}_results.csv`;
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
      .pipe(csv())
      .on('headers', (headers) => {
        filterField = headers[0]; // Use the first column as the filter field
      })
      .on('data', (data) => {
        const value = data[Object.keys(data)[0]];
        if (value && value.trim()) {
          results.push(value.trim());
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

async function querySalesforceRecords(accessToken, instanceUrl, objectName, fieldName, filterField, filterValues) {
  // Create IN clause for filtering
  const filterClause = filterValues.map(value => `'${value}'`).join(',');
  const query = `SELECT Id, ${fieldName}, ${filterField} FROM ${objectName} WHERE ${filterField} IN (${filterClause}) LIMIT 200`;
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

module.exports = { main, readCsvFile, querySalesforceRecords, sendToLMStudio, writeResultsToCSV };