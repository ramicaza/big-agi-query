// generate-config.js
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');

const outputPath = path.join('src', 'modules', 'aifn', 'bigquery', 'symb-message.ts');

async function fetchGistContent(gistUrl) {
  const response = await fetch(gistUrl);
  if (!response.ok) {
    throw new Error(`Gist fetch failed: ${response.statusText}`);
  }
  return response.text();
}

async function generateConfig() {
  let content;

  // When running on Netlify, fetch the content from the Gist
  const gistUrl = process.env.SYMB_MESSAGE_GIST_URL;
  if (!gistUrl) {
    console.warn('\nWARNING: Environment variable SYMB_MESSAGE_GIST_URL is not set. Skipping generation of symb-message.ts.\n');
    return;
  }
  content = await fetchGistContent(gistUrl);

  // Write the content to the file used in the build
  fs.writeFileSync(outputPath, content);
}

generateConfig().catch((error) => {
  console.error(error);
  process.exit(1); // Exit with a failure code
});