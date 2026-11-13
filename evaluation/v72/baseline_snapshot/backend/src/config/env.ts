/** 在其它模块读取 process.env 之前加载仓库根目录 .env。 */
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
