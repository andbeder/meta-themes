const axios = require('axios');

async function testEndpoint(url, apiKey, apiVersions = [''], headerType = 'api-key') {
  const requestBody = {
    messages: [
      {
        role: "user",
        content: "Say hello in one sentence."
      }
    ],
    temperature: 0.7,
    max_tokens: 100
  };

  for (const apiVersion of apiVersions) {
    const fullUrl = apiVersion ? `${url}?api-version=${apiVersion}` : url;

    // Try both header types
    const headerTypes = headerType === 'both' ? ['api-key', 'Authorization'] : [headerType];

    for (const hType of headerTypes) {
      const headers = {
        'Content-Type': 'application/json'
      };

      if (hType === 'api-key') {
        headers['api-key'] = apiKey;
      } else {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      try {
        console.log(`\nTrying: ${fullUrl} [${hType}]`);
        const response = await axios.post(fullUrl, requestBody, {
          headers: headers,
          timeout: 10000
        });

        console.log('✓ SUCCESS! Status:', response.status);
        if (response.data.choices && response.data.choices[0]) {
          console.log('  Response:', response.data.choices[0].message.content);
        } else {
          console.log('  Data:', JSON.stringify(response.data).substring(0, 200));
        }
        return true;
      } catch (error) {
        const status = error.response?.status;
        const errorData = error.response?.data;
        console.log('✗ Failed:', status || error.message);
        if (status === 401) {
          console.log('  Auth error - trying different header type');
        }
      }
    }
  }
  return false;
}

async function testCopilot() {
  const apiKey = process.env.COPILOT_API_KEY;
  const baseUrl = process.env.COPILOT_API_URL || 'https://abede-mgglef38-eastus2.openai.azure.com';
  const deployment = 'gpt-5-chat';

  console.log('Testing Azure OpenAI endpoints...');
  console.log('Base URL:', baseUrl);
  console.log('Deployment:', deployment);
  console.log('API Key:', apiKey ? apiKey.substring(0, 20) + '...' : 'NOT SET');

  // Standard Azure OpenAI endpoint patterns
  const endpoints = [
    // Standard Azure OpenAI format
    `${baseUrl}/openai/deployments/${deployment}/chat/completions`,
    // Alternative formats
    `${baseUrl}/deployments/${deployment}/chat/completions`,
    `${baseUrl}/${deployment}/chat/completions`,
  ];

  const apiVersions = ['2024-02-15-preview', '2024-05-01-preview', '2023-12-01-preview', '2024-02-01'];

  for (const url of endpoints) {
    const success = await testEndpoint(url, apiKey, apiVersions, 'api-key');
    if (success) {
      console.log('\n✓✓✓ WORKING ENDPOINT FOUND:', url);
      return;
    }
  }

  console.log('\n❌ No working endpoint found. Please check your Azure OpenAI deployment details.');
}

testCopilot();
