import { createServer } from './app.js';

const port = Number(process.env.PORT || 8787);
const server = createServer();

server.listen(port, () => {
  console.log(`DroneDelegation server listening on http://localhost:${port}`);
});
