import { validateGatewayFiles } from './gateway-config';

try {
  // Optional paths let offline tests exercise this exact CLI with temporary files.
  if (process.argv.length > 4) throw new Error('Expected at most initial and production config paths');
  validateGatewayFiles(process.argv[2], process.argv[3]);
  console.log('Gateway initial and production configurations are valid.');
} catch (error) {
  // Never dump config contents (including accidental credentials) to CI logs.
  console.error(error instanceof Error && error.message.startsWith('Invalid Gateway config: ')
    ? error.message : 'Gateway config validation failed; check scripts/gateway-config.ts and the configuration files.');
  process.exitCode = 1;
}
