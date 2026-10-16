import { localDev, none, vercelOidc } from 'eve/channels/auth';
import { eveChannel } from 'eve/channels/eve';

/**
 * The eve HTTP API (`/eve/v1/*`) for `/compare` and `/bench`, called from the
 * page like every other lane's routes. The project sits behind Vercel
 * deployment protection, which is the gate for every route in this app; eve's
 * own auth accepts what reaches it (`none()` last), as the demo's routes do.
 */
export default eveChannel({
  auth: [vercelOidc(), localDev(), none()],
});
