/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The example links to the parent package via `link:../..`. Next's bundler
  // needs to follow that symlink during compilation.
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
