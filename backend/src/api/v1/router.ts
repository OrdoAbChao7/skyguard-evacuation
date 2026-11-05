import { Router } from 'express';
import { authRouter } from './auth';
import { safetyRouter } from './safety';
import { mvpRouter } from './mvp';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/safety', safetyRouter);
apiRouter.use('/mvp', mvpRouter);
