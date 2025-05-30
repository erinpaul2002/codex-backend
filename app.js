// Install dependencies: express and axios
const express = require('express');
const axios = require('axios');
const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'CodeIDE Backend is running' });
});

// Get supported languages endpoint
app.get('/languages', async (req, res) => {
  try {
    // Return only the languages we support: Java, Python, C, and C++
    const supportedLanguages = [
      { id: 71, name: 'Python' },
      { id: 50, name: 'C' },
      { id: 54, name: 'C++' },
      { id: 62, name: 'Java' }
    ];
    
    res.json(supportedLanguages);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch supported languages' });
  }
});

app.post('/run', async (req, res) => {
  const { source_code, language_id, stdin } = req.body;
  
  // Validate input
  if (!source_code) {
    return res.status(400).json({ error: 'Source code is required' });
  }
  
  if (!language_id) {
    return res.status(400).json({ error: 'Language ID is required' });
  }
  
  try {
    console.log(`Executing ${language_id} code...`);
    
    // Submit code to Judge0
    const submission = await axios.post(
      'https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true',
      { 
        source_code, 
        language_id, 
        stdin: stdin || '' 
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': `${process.env.RAPID_API_KEY}`,
          'X-RapidAPI-Host': 'judge0-ce.p.rapidapi.com'
        },
        timeout: 30000 // 30 second timeout
      }
    );
    
    console.log('Execution completed:', submission.data.status);
    res.json(submission.data);
  } catch (error) {
    console.error('Error executing code:', error.message);
    
    if (error.response) {
      // Judge0 API error
      res.status(500).json({ 
        error: 'Code execution failed', 
        details: error.response.data || error.message 
      });
    } else if (error.code === 'ECONNABORTED') {
      // Timeout error
      res.status(408).json({ 
        error: 'Code execution timed out. Please check your code for infinite loops.' 
      });
    } else {
      // Network or other error
      res.status(500).json({ 
        error: 'Failed to connect to code execution service',
        details: error.message 
      });
    }
  }
});

app.listen(process.env.PORT || 8000, () => {
  console.log(`Server running on http://localhost:${process.env.PORT || 8000}`);
});