// pdf-parse ships no type declarations for its library entrypoint
// (importing the package index pulls in a brittle debug/test mode).
declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdfParse(buffer: Buffer): Promise<{ text: string; numpages: number }>;
  export default pdfParse;
}
