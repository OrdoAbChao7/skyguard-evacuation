import { Router } from 'express';
import { authRouter } from './auth';
import { safetyRouter } from './safety';
import { mvpRouter } from './mvp';
import { perceptionRouter } from './perception';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/safety', safetyRouter);
apiRouter.use('/mvp', mvpRouter);
// 感知回放展示数据独立挂载：只读、不参与任何安全判定。
apiRouter.use('/perception', perceptionRouter);
