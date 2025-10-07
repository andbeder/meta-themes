const nock = require('nock');
const { sendToCopilot } = require('./index');

describe('Copilot Integration', () => {
  beforeEach(() => {
    // Clean up any previous environment variables
    delete process.env.COPILOT_API_KEY;
    delete process.env.COPILOT_API_URL;
    nock.cleanAll();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('sendToCopilot', () => {
    it('should successfully send a request to Copilot and receive a response', async () => {
      process.env.COPILOT_API_KEY = 'test-api-key';
      process.env.COPILOT_API_URL = 'https://api.github.com/copilot_internal/v2/token';

      const prompt = 'Extract meta-themes from this survey response';
      const text = 'I love the recognition program at work. It makes me feel valued.';
      const expectedResponse = 'Meta-themes: Recognition, Employee Value, Positive Sentiment';

      // Mock the Copilot API response
      const scope = nock('https://api.github.com')
        .post('/copilot_internal/v2/token', (body) => {
          // Verify request body
          expect(body.messages).toHaveLength(2);
          expect(body.messages[0].role).toBe('system');
          expect(body.messages[1].role).toBe('user');
          expect(body.messages[1].content).toContain(prompt);
          expect(body.messages[1].content).toContain(text);
          expect(body.model).toBe('gpt-4');
          expect(body.temperature).toBe(0.7);
          expect(body.max_tokens).toBe(500);
          return true;
        })
        .reply(200, {
          choices: [
            {
              message: {
                content: expectedResponse
              }
            }
          ]
        });

      const response = await sendToCopilot(prompt, text);

      expect(response).toBe(expectedResponse);
      expect(scope.isDone()).toBe(true);
    });

    it('should throw an error when COPILOT_API_KEY is not set', async () => {
      const prompt = 'Extract meta-themes';
      const text = 'Sample text';

      await expect(sendToCopilot(prompt, text)).rejects.toThrow(
        'COPILOT_API_KEY environment variable is required for Copilot integration'
      );
    });

    it('should handle Copilot API errors', async () => {
      process.env.COPILOT_API_KEY = 'test-api-key';

      const scope = nock('https://api.github.com')
        .post('/copilot_internal/v2/token')
        .reply(401, {
          error: 'Unauthorized',
          message: 'Invalid API key'
        });

      await expect(sendToCopilot('prompt', 'text')).rejects.toThrow(
        /Copilot API error: 401/
      );

      expect(scope.isDone()).toBe(true);
    });

    it('should handle network errors', async () => {
      process.env.COPILOT_API_KEY = 'test-api-key';

      const scope = nock('https://api.github.com')
        .post('/copilot_internal/v2/token')
        .replyWithError('Network error occurred');

      await expect(sendToCopilot('prompt', 'text')).rejects.toThrow(
        /Copilot connection error/
      );

      expect(scope.isDone()).toBe(true);
    });

    it('should use custom COPILOT_API_URL when provided', async () => {
      process.env.COPILOT_API_KEY = 'test-api-key';
      process.env.COPILOT_API_URL = 'https://custom-copilot-api.example.com/v1/chat';

      const scope = nock('https://custom-copilot-api.example.com')
        .post('/v1/chat')
        .reply(200, {
          choices: [
            {
              message: {
                content: 'Custom API response'
              }
            }
          ]
        });

      const response = await sendToCopilot('prompt', 'text');

      expect(response).toBe('Custom API response');
      expect(scope.isDone()).toBe(true);
    });

    it('should include proper headers in the request', async () => {
      process.env.COPILOT_API_KEY = 'test-api-key-123';

      const scope = nock('https://api.github.com', {
        reqheaders: {
          'Authorization': 'Bearer test-api-key-123',
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      })
        .post('/copilot_internal/v2/token')
        .reply(200, {
          choices: [
            {
              message: {
                content: 'Response'
              }
            }
          ]
        });

      await sendToCopilot('prompt', 'text');

      expect(scope.isDone()).toBe(true);
    });

    it('should format the prompt and text correctly', async () => {
      process.env.COPILOT_API_KEY = 'test-api-key';

      const prompt = 'Analyze sentiment';
      const text = 'This is amazing!';

      const scope = nock('https://api.github.com')
        .post('/copilot_internal/v2/token', (body) => {
          const userMessage = body.messages[1].content;
          expect(userMessage).toBe(`${prompt}\n\nText to analyze: ${text}`);
          return true;
        })
        .reply(200, {
          choices: [
            {
              message: {
                content: 'Positive'
              }
            }
          ]
        });

      await sendToCopilot(prompt, text);

      expect(scope.isDone()).toBe(true);
    });

    it('should handle timeout correctly', async () => {
      process.env.COPILOT_API_KEY = 'test-api-key';

      const scope = nock('https://api.github.com')
        .post('/copilot_internal/v2/token')
        .delayConnection(61000) // Delay longer than timeout
        .reply(200, {
          choices: [
            {
              message: {
                content: 'Response'
              }
            }
          ]
        });

      await expect(sendToCopilot('prompt', 'text')).rejects.toThrow();

      nock.cleanAll();
    }, 70000); // Increase test timeout to 70 seconds to accommodate the 60 second delay
  });
});
