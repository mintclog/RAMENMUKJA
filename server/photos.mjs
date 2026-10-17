export function stripJpegMetadata(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('Invalid JPEG');
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('Invalid JPEG marker');
    const marker = bytes[offset + 1];
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + size + 2 > bytes.length) throw new Error('Invalid JPEG segment');
    if (marker === 0xda) {
      if (bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error('Incomplete JPEG');
      parts.push(bytes.subarray(offset));
      return Buffer.concat(parts);
    }
    // Remove EXIF/XMP/IPTC/comments while preserving the encoded image and JFIF header.
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)) parts.push(bytes.subarray(offset, offset + size + 2));
    offset += size + 2;
  }
  throw new Error('Incomplete JPEG');
}
