/** Loads .env.local (then .env) for scripts. Import this first. */
import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
