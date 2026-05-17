import { Router, Request, Response } from 'express';
import { getFileStatus } from '../lib/statusStore';

export const statusRouter = Router();

statusRouter.get('/status/:fileId', async (req: Request, res: Response): Promise<void> => {
  try {
    const status = await getFileStatus(req.params.fileId);
    if (!status) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json(status);
  } catch (err) {
    console.error('[api] Status query failed:', err);
    res.status(500).json({ error: 'Failed to fetch status' });
  }
});
