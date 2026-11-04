import { Router } from 'express';
import { authRouter } from './auth';
import { safetyRouter } from './safety';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/safety', safetyRouter);
