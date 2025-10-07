#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const csv = require('csv-parser');

async function main() {
  const args = process.argv.slice(2);

  // Check for -c flag
  const useCopilot = args.includes('-c');
  const filteredArgs = args.filter(arg => arg !== '-c');

  // Parse arguments
  const batchIndex = filteredArgs.indexOf('-b');
  const promptIndex = filteredArgs.indexOf('-p');

  if (batchIndex === -1 || promptIndex === -1 || filteredArgs.length < 5) {
    console.error('Usage: node summarize.js <filename> -b <batch-size> -p <prompt> [-c]');
    console.error('Example: node summarize.js results.csv -b 5 -p "Summarize the key themes across these responses"');
    console.error('Example with Copilot: node summarize.js results.csv -b 5 -p "Summarize themes" -c');
    console.error('Use -c flag to use Copilot instead of LM Studio');
    process.exit(1);
  }

  const filename = filteredArgs[0];
  const batchSize = parseInt(filteredArgs[batchIndex + 1]);

  // Collect all arguments after -p as the prompt (to handle multi-word prompts)
  const prompt = filteredArgs.slice(promptIndex + 1).join(' ');

  if (isNaN(batchSize) || batchSize < 1) {
    console.error('Error: Batch size must be a positive integer');
    process.exit(1);
  }

  if (!fs.existsSync(filename)) {
    console.error(`Error: File '${filename}' not found`);
    process.exit(1);
  }

  console.log(`Reading file: ${filename}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Prompt: "${prompt}"`);
  console.log(`AI Service: ${useCopilot ? 'Microsoft Copilot' : 'LM Studio'}`);
  console.log('');

  try {
    // Read CSV file and extract LM Studio Response column
    const responses = await readResponsesFromCSV(filename);
    console.log(`Found ${responses.length} responses in file`);

    if (responses.length === 0) {
      console.log('No responses to process');
      process.exit(0);
    }

    // Split into batches
    const batches = chunkArray(responses, batchSize);
    console.log(`Split into ${batches.length} batches of up to ${batchSize} responses each`);
    console.log('');

    // Process each batch
    const summaries = [];
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} responses)...`);

      // Combine batch responses into a single text
      const combinedText = batch.map((resp, idx) => {
        return `Response ${idx + 1}:\n${resp}`;
      }).join('\n\n---\n\n');

      try {
        const summary = useCopilot ?
          await sendToCopilot(prompt, combinedText) :
          await sendToLMStudio(prompt, combinedText);

        summaries.push({
          batchNumber: i + 1,
          batchSize: batch.length,
          summary: summary
        });

        console.log(`  ✓ Batch ${i + 1} processed successfully`);
        console.log('');
      } catch (error) {
        console.error(`  ✗ Error processing batch ${i + 1}:`, error.message);
        summaries.push({
          batchNumber: i + 1,
          batchSize: batch.length,
          summary: `Error: ${error.message}`
        });
      }
    }

    // Save summaries to output file
    const outputFile = generateOutputFilename(filename, batchSize);
    await saveSummariesToFile(summaries, outputFile, prompt);

    console.log(`\n✓ Summaries saved to: ${outputFile}`);
    console.log(`Processed ${batches.length} batches successfully`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

async function readResponsesFromCSV(filename) {
  return new Promise((resolve, reject) => {
    const responses = [];

    fs.createReadStream(filename)
      .pipe(csv({
        skipEmptyLines: true,
        stripBOM: true
      }))
      .on('data', (data) => {
        // Try different possible column names for the response field
        const response = data['LM Studio Response'] ||
                        data['response'] ||
                        data['Response'] ||
                        data[Object.keys(data)[Object.keys(data).length - 1]]; // Last column as fallback

        if (response && response.trim() && !response.startsWith('Error:')) {
          responses.push(response.trim());
        }
      })
      .on('end', () => {
        resolve(responses);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

async function sendToLMStudio(prompt, text) {
  const lmStudioUrl = process.env.LM_STUDIO_URL || 'http://127.0.0.1:1234/v1/chat/completions';

  const requestBody = {
    model: "local-model",
    messages: [
      {
        role: "user",
        content: `${prompt}\n\n${text}`
      }
    ],
    temperature: 0.7,
    max_tokens: 2000 // Increased for summaries
  };

  try {
    const response = await axios.post(lmStudioUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      },
      timeout: 60000 // 60 second timeout for larger batches
    });

    return response.data.choices[0].message.content;
  } catch (error) {
    if (error.response) {
      throw new Error(`LM Studio API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`LM Studio connection error: ${error.message}`);
  }
}

async function sendToCopilot(prompt, text) {
  const copilotApiKey = process.env.COPILOT_API_KEY;
  const copilotUrl = process.env.COPILOT_API_URL;
  const deployment = process.env.COPILOT_DEPLOYMENT || 'gpt-5-chat';
  const apiVersion = process.env.AZURE_API_VERSION || '2024-02-15-preview';

  if (!copilotApiKey) {
    throw new Error('COPILOT_API_KEY environment variable is required for Copilot integration');
  }

  if (!copilotUrl) {
    throw new Error('COPILOT_API_URL environment variable is required. Set it to your Azure OpenAI base URL (e.g., https://xxx.openai.azure.com)');
  }

  // Build Azure OpenAI endpoint URL
  const fullUrl = `${copilotUrl}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const requestBody = {
    messages: [
      {
        role: "system",
        content: "You are a helpful AI assistant that analyzes and summarizes multiple text responses to identify patterns, themes, and insights."
      },
      {
        role: "user",
        content: `${prompt}\n\n${text}`
      }
    ],
    temperature: 0.7,
    max_tokens: 2000 // Increased for summaries
  };

  try {
    const response = await axios.post(fullUrl, requestBody, {
      headers: {
        'api-key': copilotApiKey,
        'Content-Type': 'application/json'
      },
      timeout: 120000 // 2 minute timeout for larger batches
    });

    if (response.data.choices && response.data.choices[0]) {
      return response.data.choices[0].message.content;
    } else {
      throw new Error(`Unexpected API response format: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    if (error.response) {
      throw new Error(`Copilot API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Copilot connection error: ${error.message}`);
  }
}

function generateOutputFilename(inputFilename, batchSize) {
  const parsed = path.parse(inputFilename);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  return path.join(
    parsed.dir || '.',
    `${parsed.name}_summary_batch${batchSize}_${timestamp}.txt`
  );
}

async function saveSummariesToFile(summaries, filename, prompt) {
  let content = `Summary Report\n`;
  content += `Generated: ${new Date().toISOString()}\n`;
  content += `Prompt: ${prompt}\n`;
  content += `Total Batches: ${summaries.length}\n`;
  content += `\n${'='.repeat(80)}\n\n`;

  for (const summary of summaries) {
    content += `BATCH ${summary.batchNumber} (${summary.batchSize} responses)\n`;
    content += `${'-'.repeat(80)}\n`;
    content += `${summary.summary}\n`;
    content += `\n${'='.repeat(80)}\n\n`;
  }

  await fs.promises.writeFile(filename, content, 'utf8');
}

if (require.main === module) {
  main();
}

module.exports = { main, readResponsesFromCSV, chunkArray, sendToLMStudio, sendToCopilot, saveSummariesToFile };
