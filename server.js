// server.js - OpenAI to Blaze/NVIDIA Inference API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ---------------------------------------------------------
// API PROVIDER CONFIGURATION
// ---------------------------------------------------------

// Blaze
const BLAZE_API_BASE =
  process.env.BLAZE_API_BASE || 'https://blazeinference.com/v1';

// NVIDIA
const NVIDIA_API_BASE =
  process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1';

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE
const SHOW_REASONING = false;

// ---------------------------------------------------------
// Model mapping
// ---------------------------------------------------------

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

// ---------------------------------------------------------
// Health check
// ---------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to Blaze/NVIDIA Proxy',
    reasoning_display: SHOW_REASONING
  });
});

// ---------------------------------------------------------
// List models endpoint
// ---------------------------------------------------------

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'blaze-nvidia-proxy'
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// ---------------------------------------------------------
// Chat completions endpoint
// ---------------------------------------------------------

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
    // Determine requested provider
    //
    // Normal:
    // Authorization: Bearer sk-blaze-xxxx
    //
    // NVIDIA:
    // Authorization: Bearer nvidia
    //
    // Or:
    // { "api_key": "nvidia" }
    // { "apiKey": "nvidia" }
    // ---------------------------------------------------------

    let suppliedApiKey = null;

    const authorization = req.headers.authorization;

    if (
      authorization &&
      authorization.toLowerCase().startsWith('bearer ')
    ) {
      suppliedApiKey = authorization.substring(7).trim();
    }

    if (!suppliedApiKey && req.body.api_key) {
      suppliedApiKey = req.body.api_key;
    }

    if (!suppliedApiKey && req.body.apiKey) {
      suppliedApiKey = req.body.apiKey;
    }

    if (!suppliedApiKey) {
      return res.status(401).json({
        error: {
          message:
            'Missing API key. Provide it through the Authorization header or api_key in the request body.',
          type: 'authentication_error',
          code: 'missing_api_key'
        }
      });
    }

    // ---------------------------------------------------------
    // PROVIDER SELECTION
    // ---------------------------------------------------------

    const useNvidia =
      suppliedApiKey.toLowerCase() === 'nvidia';

    let apiBase;
    let upstreamApiKey;
    let upstreamModel;

    if (useNvidia) {

      // -------------------------------------------------------
      // NVIDIA MODE
      // -------------------------------------------------------

      if (!NVIDIA_API_KEY) {
        console.error(
          'NVIDIA_API_KEY environment variable is not configured.'
        );

        return res.status(500).json({
          error: {
            message: 'NVIDIA API key is not configured on the proxy server.',
            type: 'configuration_error',
            code: 'missing_nvidia_api_key'
          }
        });
      }

      apiBase = NVIDIA_API_BASE;

      // IMPORTANT:
      // Use the secret stored in the server environment.
      // Do NOT use "nvidia" as the real upstream API key.
      upstreamApiKey = NVIDIA_API_KEY;

      // NVIDIA uses its own model names.
      //
      // If the client sends one of your aliases, translate it.
      // Otherwise pass the model name through unchanged.
      upstreamModel = MODEL_MAPPING[model] || model;

      console.log(
        `Routing request to NVIDIA: model=${upstreamModel}`
      );

    } else {

      // -------------------------------------------------------
      // BLAZE MODE
      // -------------------------------------------------------

      apiBase = BLAZE_API_BASE;
      upstreamApiKey = suppliedApiKey;

      upstreamModel = MODEL_MAPPING[model] || model;

      console.log(
        `Routing request to Blaze: model=${upstreamModel}`
      );
    }

    // ---------------------------------------------------------
    // Build upstream request
    // ---------------------------------------------------------

    const upstreamRequest = {
      model: upstreamModel,
      messages: messages,
      temperature: temperature ?? 0.85,
      max_tokens: max_tokens ?? 9024,

      // Always request streaming from upstream if the client
      // requested streaming.
      stream: !!stream
    };

    // ---------------------------------------------------------
    // Make request
    // ---------------------------------------------------------

    const response = await axios.post(
      `${apiBase}/chat/completions`,
      upstreamRequest,
      {
        headers: {
          'Authorization': `Bearer ${upstreamApiKey}`,
          'Content-Type': 'application/json'
        },

        // IMPORTANT:
        //
        // For streaming, Axios must receive the response as a
        // stream.
        responseType: stream ? 'stream' : 'json'
      }
    );

    // ---------------------------------------------------------
    // STREAMING RESPONSE
    // ---------------------------------------------------------

    if (stream) {

      res.setHeader(
        'Content-Type',
        'text/event-stream'
      );

      res.setHeader(
        'Cache-Control',
        'no-cache'
      );

      res.setHeader(
        'Connection',
        'keep-alive'
      );

      let buffer = '';

      response.data.on('data', (chunk) => {

        buffer += chunk.toString();

        const lines = buffer.split('\n');

        buffer = lines.pop() || '';

        lines.forEach(line => {

          if (!line.startsWith('data: ')) {
            return;
          }

          // ---------------------------------------------------
          // DONE
          // ---------------------------------------------------

          if (line.includes('[DONE]')) {
            res.write(line + '\n\n');
            return;
          }

          try {

            const data = JSON.parse(
              line.slice(6)
            );

            // -------------------------------------------------
            // Reasoning handling
            // -------------------------------------------------

            if (
              SHOW_REASONING &&
              data.choices?.[0]?.delta
            ) {

              const delta =
                data.choices[0].delta;

              const reasoning =
                delta.reasoning_content;

              const content =
                delta.content;

              if (reasoning) {

                delta.content =
                  `<think>\n${reasoning}`;

                delete delta.reasoning_content;
              }

              if (content && reasoning) {

                delta.content +=
                  `</think>\n\n${content}`;
              }

            } else if (
              data.choices?.[0]?.delta?.reasoning_content
            ) {

              // Hide reasoning if disabled
              delete data.choices[0].delta.reasoning_content;
            }

            res.write(
              `data: ${JSON.stringify(data)}\n\n`
            );

          } catch (e) {

            // Pass through anything that isn't JSON
            res.write(line + '\n\n');
          }
        });
      });

      response.data.on('end', () => {
        res.end();
      });

      response.data.on('error', (err) => {

        console.error(
          'Stream error:',
          err.message
        );

        res.end();
      });

    } else {

      // ---------------------------------------------------------
      // NON-STREAM RESPONSE
      // ---------------------------------------------------------

      res.json(response.data);
    }

  } catch (error) {

    console.error(
      '========== PROXY ERROR =========='
    );

    console.error(
      'Status:',
      error.response?.status
    );

    console.error(
      'Message:',
      error.message
    );

    console.error(
      'Code:',
      error.code
    );

    let upstreamBody = null;

    // ---------------------------------------------------------
    // Read upstream error stream
    // ---------------------------------------------------------

    if (
      error.response?.data &&
      typeof error.response.data.on === 'function'
    ) {

      try {

        const chunks = [];

        for await (
          const chunk of error.response.data
        ) {

          chunks.push(
            Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk)
          );
        }

        upstreamBody =
          Buffer.concat(chunks).toString('utf8');

        console.error(
          'Upstream response body:',
          upstreamBody.substring(0, 10000)
        );

      } catch (streamError) {

        console.error(
          'Could not read upstream error stream:',
          streamError.message
        );
      }

    } else if (error.response?.data) {

      if (
        typeof error.response.data === 'string'
      ) {

        upstreamBody =
          error.response.data;

      } else {

        upstreamBody =
          JSON.stringify(error.response.data);
      }

      console.error(
        'Upstream response body:',
        upstreamBody.substring(0, 10000)
      );
    }

    console.error(
      '================================='
    );

    // ---------------------------------------------------------
    // Return upstream error to client
    // ---------------------------------------------------------

    if (upstreamBody) {

      try {

        const parsed =
          JSON.parse(upstreamBody);

        return res
          .status(error.response?.status || 500)
          .json(parsed);

      } catch (parseError) {

        return res
          .status(error.response?.status || 500)
          .type('text/plain')
          .send(upstreamBody);
      }
    }

    return res
      .status(error.response?.status || 500)
      .json({
        error: {
          message:
            error.message ||
            'Internal server error',

          type: 'proxy_error',

          code:
            error.response?.status ||
            500
        }
      });
  }
});

// ---------------------------------------------------------
// Catch-all
// ---------------------------------------------------------

app.all('*', (req, res) => {

  res.status(404).json({
    error: {
      message:
        `Endpoint ${req.path} not found`,

      type:
        'invalid_request_error',

      code: 404
    }
  });
});

// ---------------------------------------------------------
// Start server
// ---------------------------------------------------------

app.listen(PORT, () => {

  console.log(
    `OpenAI to Blaze/NVIDIA Proxy running on port ${PORT}`
  );

  console.log(
    `Health check: http://localhost:${PORT}/health`
  );

  console.log(
    `Blaze API: ${BLAZE_API_BASE}`
  );

  console.log(
    `NVIDIA API: ${NVIDIA_API_BASE}`
  );

  console.log(
    `NVIDIA key configured: ${NVIDIA_API_KEY ? 'YES' : 'NO'}`
  );

  console.log(
    `Reasoning display: ${
      SHOW_REASONING ? 'ENABLED' : 'DISABLED'
    }`
  );
});
