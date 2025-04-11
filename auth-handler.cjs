const http = require('http');
const fs = require('fs');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/auth') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString(); // Convert Buffer chunks to string
    });
    req.on('end', () => {
      // Assuming the client sends a JSON string like {"access_token": "...", "refresh_token": "..."}
      console.log(`Received token payload: "${body}"`); 
      
      // Validate if the body is actually JSON before writing (optional but recommended)
      try {
        JSON.parse(body); // Try parsing to check if it's valid JSON
      } catch (e) {
        console.error('Received payload is not valid JSON:', body);
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request: Invalid JSON payload');
        return;
      }

      // Write the received JSON string directly to the file
      fs.writeFile('/tmp/auth_token.txt', body, (err) => { // Write the raw body
        if (err) {
          console.error('Error writing token to file:', err);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        } else {
          console.log('Token payload successfully written to /tmp/auth_token.txt');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Token received');
        }
      });
    });
  } else {
    // Handle other routes/methods
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const PORT = 8001;
server.listen(PORT, () => {
  console.log(`Auth handler listening on port ${PORT}`);
}); 