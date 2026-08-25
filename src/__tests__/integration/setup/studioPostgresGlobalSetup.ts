/** PostgreSQL-only global setup for the required Vex Studio CI lane. */

import {
  setupPostgresWithoutEmbeddings,
  teardown as teardownPostgres,
} from "./globalSetup.js";

export async function setup(): Promise<void> {
  await setupPostgresWithoutEmbeddings();
}

export async function teardown(): Promise<void> {
  await teardownPostgres();
}
