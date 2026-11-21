require('dotenv').config({ quiet: true });
const { createApp } = require('./server');
const port = Number(process.env.PORT || 8001);
const app = createApp();
app.listen(port, '127.0.0.1', () => {
  console.log(`Local AWS Console: http://127.0.0.1:${port}`);
});
