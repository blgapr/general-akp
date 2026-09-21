/*
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
*/
// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '20mb' }));
 
// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = true; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = false; // Set to true to enable chat_template_kwargs thinking parameter

// Model mapping (adjust based on available NIM models)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking',
  'glm-5.2': 'z-ai/glm-5.2',
 'meta/llama-3.1-70b-instruct': 'meta/llama-3.1-70b-instruct'
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    nimModel = model;
    // Smart model selection with fallback
    /*let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      try {
        await axios.post(`${NIM_API_BASE}/chat/completions`, {
          model: model,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 1
        }, {
          headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
          validateStatus: (status) => status < 500
        }).then(res => {
          if (res.status >= 200 && res.status < 300) {
            nimModel = model;
          }
        });
      } catch (e) {}
      
      if (!nimModel) {
        const modelLower = model.toLowerCase();
        if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus') || modelLower.includes('405b')) {
          nimModel = 'meta/llama-3.1-405b-instruct';
        } else if (modelLower.includes('claude') || modelLower.includes('gemini') || modelLower.includes('70b')) {
          nimModel = 'meta/llama-3.1-70b-instruct';
        } else {
          nimModel = 'meta/llama-3.1-8b-instruct';
        }
      }
    }*/
    
    // Dynamically enable thinking arguments ONLY for DeepSeek and Gemma models
    const modelLower = nimModel.toLowerCase();
    let extraBody = undefined;
    
    if (modelLower.includes('deepseek')) {
      extraBody = { chat_template_kwargs: { enable_thinking: true, thinking: true } };
    }

    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.85,
      max_tokens: max_tokens || 9024,
      extra_body: extraBody,
      stream: stream || false
    };
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    if (stream) {
      // Handle streaming response with reasoning
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Transform NIM response to OpenAI format with reasoning
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
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
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
