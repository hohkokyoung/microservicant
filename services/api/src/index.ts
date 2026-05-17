import express from 'express';
import path from 'path';
import { uploadRouter } from './routes/upload';
import { statusRouter } from './routes/status';

const app  = express();
const PORT = process.env.PORT ?? 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

app.use('/api', uploadRouter);
app.use('/api', statusRouter);

app.listen(PORT, () => {
  console.log(`[api] Server running on http://localhost:${PORT}`);
  // No resultsConsumer needed — workers write directly to DynamoDB
});
