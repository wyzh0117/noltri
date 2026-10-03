import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * The @noltri packages publish raw TypeScript sources (main -> src/index.ts) with no build step,
   * so Next must compile them itself instead of expecting dist output.
   */
  transpilePackages: ['@noltri/schema', '@noltri/api-client', '@noltri/shared'],
};

export default nextConfig;
