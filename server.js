// server.js - OpenAI to Blaze Inference API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Blaze Inference API configuration
const BLAZE_API_BASE = process.env.BLAZE_API_BASE || 'https://blazeinference.com/v1';

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = false; // Set to true to show reasoning with <think> tags

// Model mapping
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'deepseek-ai/deepseek-v4-flash',
  'gpt-4': 'deepseek-ai/deepseek-v4-pro',
  'gpt-4-turbo': 'moonshotai/kimi-k2.6',
  'gpt-4o': 'z-ai/glm-5.2',
  'claude-3-opus': 'deepseek-ai/deepseek-v4-pro',
  'claude-3-sonnet': 'deepseek-ai/deepseek-v4-flash',
  'gemini-pro': 'z-ai/glm-5.2',
  'glm-5.2': 'z-ai/glm-5.2',
  'meta/llama-3.1-70b-instruct': 'deepseek-ai/deepseek-v4-flash'
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to Blaze Inference Proxy',
    reasoning_display: SHOW_REASONING
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'blaze-inference-proxy'
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const {
      model,
      messages,
      temperature,
      max_tokens,
      stream
    } = req.body;

    // ---------------------------------------------------------
    // Get Blaze API key
    //
    // Supports BOTH:
    //
    // 1. Normal OpenAI-style Authorization header:
    //    Authorization: Bearer sk-blaze-...
    //
    // 2. JSON body:
    //    { "api_key": "sk-blaze-..." }
    //
    // 3. JSON body:
    //    { "apiKey": "sk-blaze-..." }
    //
    // This means you can change the Blaze key from JanitorAI
    // without changing anything on Railway.
    // ---------------------------------------------------------

    let blazeApiKey = null;

    const authorization = req.headers.authorization;

    if (authorization && authorization.toLowerCase().startsWith('bearer ')) {
      blazeApiKey = authorization.substring(7).trim();
    }

    if (!blazeApiKey && req.body.api_key) {
      blazeApiKey = req.body.api_key;
    }

    if (!blazeApiKey && req.body.apiKey) {
      blazeApiKey = req.body.apiKey;
    }

    if (!blazeApiKey) {
      return res.status(401).json({
        error: {
          message: 'Missing Blaze API key. Provide it through the Authorization header or api_key in the request body.',
          type: 'authentication_error',
          code: 'missing_api_key'
        }
      });
    }

    // ---------------------------------------------------------
    // Select Blaze model
    // ---------------------------------------------------------

    const blazeModel = MODEL_MAPPING[model] || model;

    // ---------------------------------------------------------
    // Build request for Blaze
    //
    // Blaze is already OpenAI-compatible, so we don't need
    // NVIDIA-specific transformations.
    // ---------------------------------------------------------

    const blazeRequest = {
      model: blazeModel,
      messages: messages,
      temperature: temperature || 0.85,
      max_tokens: max_tokens || 9024,
      stream: stream || false
    };

    // ---------------------------------------------------------
    // Make request to Blaze Inference API
    // ---------------------------------------------------------

    const response = await axios.post(
      `${BLAZE_API_BASE}/chat/completions`,
      blazeRequest,
      {
        headers: {
          'Authorization': `Bearer ${blazeApiKey}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      // -------------------------------------------------------
      // Handle streaming response
      //
      // Blaze already uses OpenAI-compatible SSE, so we mostly
      // pass the stream through unchanged.
      // -------------------------------------------------------

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n\n');
              return;
            }

            try {
              const data = JSON.parse(line.slice(6));

              // Optional reasoning conversion.
              //
              // If Blaze provides reasoning_content and
              // SHOW_REASONING is enabled, convert it into
              // <think> tags for Janitor.
              if (
                SHOW_REASONING &&
                data.choices?.[0]?.delta
              ) {
                const delta = data.choices[0].delta;

                const reasoning = delta.reasoning_content;
                const content = delta.content;

                if (reasoning) {
                  delta.content = `<think>\n${reasoning}`;
                  delete delta.reasoning_content;
                }

                if (content && reasoning) {
                  delta.content += `</think>\n\n${content}`;
                }
              } else if (data.choices?.[0]?.delta?.reasoning_content) {
                // Hide reasoning if disabled
                delete data.choices[0].delta.reasoning_content;
              }

              res.write(`data: ${JSON.stringify(data)}\n\n`);

            } catch (e) {
              // Pass through anything that isn't JSON
              res.write(line + '\n\n');
            }
          }
        });
      });

      response.data.on('end', () => {
        res.end();
      });

      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });

    } else {

      // -------------------------------------------------------
      // Non-stream response
      //
      // Blaze is already OpenAI-compatible, so return its
      // response directly instead of rebuilding it.
      // -------------------------------------------------------

      res.json(response.data);
    }

  } catch (error) {

    console.error('========== PROXY ERROR ==========');
    console.error('Message:', error.message);
    console.error('Code:', error.code);
    console.error('Status:', error.response?.status);

    if (error.response) {
      console.error('Response headers:', error.response.headers);

      if (typeof error.response.data === 'string') {
        console.error('Blaze response body:', error.response.data);
      } else if (Buffer.isBuffer(error.response.data)) {
        console.error(
          'Blaze response body:',
          error.response.data.toString()
        );
      } else {
        console.error(
          'Blaze response data:',
          error.response.data
        );
      }
    }

    console.error('=================================');

    if (error.response?.data && typeof error.response.data === 'object') {
      return res.status(error.response.status || 500).json(error.response.data);
    }

    return res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'proxy_error',
        code: error.response?.status || 500
      }
    });
  }


});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to Blaze Inference Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Blaze API: ${BLAZE_API_BASE}`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
});
