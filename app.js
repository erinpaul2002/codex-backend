// Install dependencies: express and axios
const express = require('express');
const axios = require('axios');
const { spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
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

// --- Real-time Python, Java, C, and C++ interactive execution (WebSocket) ---
// Usage: connect to ws://localhost:8000/python-terminal, send { code: '...', input: '...', language: 'python|java|c|c++' } to start, then send { input: '...' } for further input
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/python-terminal' });

wss.on('connection', (ws) => {
  let proc = null;
  let started = false;
  let closed = false;
  let tempDir = null;

  ws.on('message', async (msg) => {
    if (closed) return;
    try {
      const data = JSON.parse(msg);      if (!started && data.code) {
        // Detect language: Python, Java, C, or C++
        if (data.language === 'java') {
          // --- JAVA INTERACTIVE EXECUTION ---
          // Write code to Main.java in a temp dir
          tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'java-'));
          const javaFile = path.join(tempDir, 'Main.java');
          fs.writeFileSync(javaFile, data.code);
          // Compile
          const compile = spawn('javac', [javaFile], { cwd: tempDir });
          let compileErr = '';
          compile.stderr.on('data', (chunk) => { compileErr += chunk.toString(); });
          compile.on('close', (code) => {
            if (code !== 0) {
              ws.send(JSON.stringify({ type: 'stderr', data: compileErr || 'Compilation failed.' }));
              ws.send(JSON.stringify({ type: 'exit', code }));
              ws.close();
              closed = true;
              fs.rmSync(tempDir, { recursive: true, force: true });
              return;
            }
            // Run the class
            proc = spawn('java', ['-cp', tempDir, 'Main'], { cwd: tempDir, stdio: ['pipe', 'pipe', 'pipe'] });
            started = true;
            proc.stdout.on('data', (chunk) => {
              ws.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }));
            });
            proc.stderr.on('data', (chunk) => {
              ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }));
            });
            proc.on('close', (code) => {
              ws.send(JSON.stringify({ type: 'exit', code }));
              ws.close();
              closed = true;
              fs.rmSync(tempDir, { recursive: true, force: true });
            });
            // If initial input provided
            if (data.input) {
              proc.stdin.write(data.input + '\n');
            }
          });        } else if (data.language === 'c') {
          // --- C INTERACTIVE EXECUTION ---
          // Write code to main.c in a temp dir
          tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'c-'));
          const cFile = path.join(tempDir, 'main.c');
          const execFile = path.join(tempDir, 'main.exe');
          
          // Preprocess C code to add automatic flushing after printf statements
          let processedCode = data.code;
          
          // Add fflush(stdout) after printf, fprintf(stdout), and puts statements
          processedCode = processedCode.replace(
            /(\bprintf\s*\([^;]*;)/g, 
            '$1 fflush(stdout);'
          );
          processedCode = processedCode.replace(
            /(\bfprintf\s*\(\s*stdout\s*,[^;]*;)/g, 
            '$1 fflush(stdout);'
          );
          processedCode = processedCode.replace(
            /(\bputs\s*\([^;]*;)/g, 
            '$1 fflush(stdout);'
          );
          
          fs.writeFileSync(cFile, processedCode);
          
          // Compile
          const compile = spawn('gcc', [cFile, '-o', execFile, '-static-libgcc'], { cwd: tempDir });
          let compileErr = '';
          compile.stderr.on('data', (chunk) => { compileErr += chunk.toString(); });
          compile.on('close', (code) => {
            if (code !== 0) {
              ws.send(JSON.stringify({ type: 'stderr', data: compileErr || 'Compilation failed.' }));
              ws.send(JSON.stringify({ type: 'exit', code }));
              ws.close();
              closed = true;
              fs.rmSync(tempDir, { recursive: true, force: true });
              return;
            }
            
            // Try to run with stdbuf first (available in most Linux containers)
            // If stdbuf fails, fall back to regular execution
            const tryStdbuf = spawn('which', ['stdbuf'], { stdio: 'pipe' });
            tryStdbuf.on('close', (stdbufCode) => {
              let command, args;
              if (stdbufCode === 0) {
                // stdbuf is available - use it to force line buffering
                command = 'stdbuf';
                args = ['-o0', '-e0', execFile];
              } else {
                // stdbuf not available - use direct execution
                command = execFile;
                args = [];
              }
              
              proc = spawn(command, args, { 
                cwd: tempDir, 
                stdio: ['pipe', 'pipe', 'pipe']
              });
              started = true;
              
              proc.stdout.on('data', (chunk) => {
                ws.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }));
              });
              proc.stderr.on('data', (chunk) => {
                ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }));
              });
              proc.on('close', (code) => {
                ws.send(JSON.stringify({ type: 'exit', code }));
                ws.close();
                closed = true;
                fs.rmSync(tempDir, { recursive: true, force: true });
              });
              
              // If initial input provided
              if (data.input) {
                proc.stdin.write(data.input + '\n');
              }
            });
          });        } else if (data.language === 'c++') {
          // --- C++ INTERACTIVE EXECUTION ---
          // Write code to main.cpp in a temp dir
          tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cpp-'));
          const cppFile = path.join(tempDir, 'main.cpp');
          const execFile = path.join(tempDir, 'main.exe');
          
          // Preprocess C++ code to add automatic flushing after cout statements
          let processedCode = data.code;
          
          // Add cout.flush() or cout << flush after cout statements
          processedCode = processedCode.replace(
            /(\bcout\s*<<[^;]*;)/g, 
            '$1 cout.flush();'
          );
          // Also handle printf in C++ code
          processedCode = processedCode.replace(
            /(\bprintf\s*\([^;]*;)/g, 
            '$1 fflush(stdout);'
          );
          processedCode = processedCode.replace(
            /(\bputs\s*\([^;]*;)/g, 
            '$1 fflush(stdout);'
          );
          
          fs.writeFileSync(cppFile, processedCode);
          
          // Compile
          const compile = spawn('g++', [cppFile, '-o', execFile, '-static-libgcc', '-static-libstdc++'], { cwd: tempDir });
          let compileErr = '';
          compile.stderr.on('data', (chunk) => { compileErr += chunk.toString(); });
          compile.on('close', (code) => {
            if (code !== 0) {
              ws.send(JSON.stringify({ type: 'stderr', data: compileErr || 'Compilation failed.' }));
              ws.send(JSON.stringify({ type: 'exit', code }));
              ws.close();
              closed = true;
              fs.rmSync(tempDir, { recursive: true, force: true });
              return;
            }
            
            // Try to run with stdbuf first (available in most Linux containers)
            // If stdbuf fails, fall back to regular execution
            const tryStdbuf = spawn('which', ['stdbuf'], { stdio: 'pipe' });
            tryStdbuf.on('close', (stdbufCode) => {
              let command, args;
              if (stdbufCode === 0) {
                // stdbuf is available - use it to force line buffering
                command = 'stdbuf';
                args = ['-o0', '-e0', execFile];
              } else {
                // stdbuf not available - use direct execution
                command = execFile;
                args = [];
              }
              
              proc = spawn(command, args, { 
                cwd: tempDir, 
                stdio: ['pipe', 'pipe', 'pipe']
              });
              started = true;
              
              proc.stdout.on('data', (chunk) => {
                ws.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }));
              });
              proc.stderr.on('data', (chunk) => {
                ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }));
              });
              proc.on('close', (code) => {
                ws.send(JSON.stringify({ type: 'exit', code }));
                ws.close();
                closed = true;
                fs.rmSync(tempDir, { recursive: true, force: true });
              });
              
              // If initial input provided
              if (data.input) {
                proc.stdin.write(data.input + '\n');
              }
            });
          });
        } else {
          // --- PYTHON INTERACTIVE EXECUTION (existing) ---
          proc = spawn('python', ['-u', '-c', data.code]);
          started = true;
          proc.stdout.on('data', (chunk) => {
            ws.send(JSON.stringify({ type: 'stdout', data: chunk.toString() }));
          });
          proc.stderr.on('data', (chunk) => {
            ws.send(JSON.stringify({ type: 'stderr', data: chunk.toString() }));
          });
          proc.on('close', (code) => {
            ws.send(JSON.stringify({ type: 'exit', code }));
            ws.close();
            closed = true;
          });
          if (data.input) {
            proc.stdin.write(data.input + '\n');
          }
        }      } else if (started && data.input && proc) {
        // Only write input if process is running and stdin is writable
        if (proc.exitCode === null && proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.write(data.input + '\n');
        } else {
          ws.send(JSON.stringify({ type: 'error', error: 'Process is not running or cannot accept input.' }));
        }
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: e.message }));
    }
  });

  ws.on('close', () => {
    if (proc && !closed) {
      proc.kill();
      closed = true;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// Listen using the custom server for WebSocket support
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});