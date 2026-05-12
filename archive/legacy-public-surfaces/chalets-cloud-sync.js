import { startChaletsCloudSync } from './src/lib/syncService.js';

startChaletsCloudSync().catch((error) => {
  console.error(error);
});
