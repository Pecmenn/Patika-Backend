import { ApiError } from '../http.ts';

const MARKER = 0xff;
const START_OF_SCAN = 0xda;
const END_OF_IMAGE = 0xd9;
const APP0 = 0xe0;
const APP15 = 0xef;
const COMMENT = 0xfe;

// Uzunluk bilgisi taşımayan işaretler.
function isStandalone(marker: number) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= END_OF_IMAGE);
}

// Herkese açılacak fotoğraftaki gizli bilgileri siler: GPS konumu, cihaz modeli, çekim zamanı, yorumlar.
// Android'in kırpma aracı GPS bilgisini kopyalıyor. Silinmezse ilan fotoğrafını indiren kişi
// evin konumunu öğrenebilir, oysa tam konum yalnızca sahibine görünür.
// Görüntü verisine dokunulmaz, yeniden sıkıştırma olmaz.
export function stripJpegMetadata(input: Buffer) {
  const invalid = () => new ApiError(400, 'invalid_photo');
  if (input.length < 2 || input[0] !== MARKER || input[1] !== 0xd8) {
    throw invalid();
  }

  const parts: Buffer[] = [input.subarray(0, 2)];
  let offset = 2;

  while (offset < input.length) {
    if (input[offset] !== MARKER || offset + 1 >= input.length) {
      throw invalid();
    }
    const marker = input[offset + 1]!;
    // Boşluk doldurma baytları.
    if (marker === MARKER) {
      offset += 1;
      continue;
    }
    if (isStandalone(marker)) {
      parts.push(input.subarray(offset, offset + 2));
      offset += 2;
      if (marker === END_OF_IMAGE) {
        break;
      }
      continue;
    }
    if (offset + 4 > input.length) {
      throw invalid();
    }
    const length = input.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > input.length) {
      throw invalid();
    }
    // Görüntü verisi başladı: kalan her şey olduğu gibi kopyalanır.
    if (marker === START_OF_SCAN) {
      parts.push(input.subarray(offset));
      offset = input.length;
      break;
    }
    // APP0 temel biçim bilgisidir, kalır. APP1-APP15 ve yorumlar üst veridir.
    const isMetadata = (marker > APP0 && marker <= APP15) || marker === COMMENT;
    if (!isMetadata) {
      parts.push(input.subarray(offset, end));
    }
    offset = end;
  }

  return Buffer.concat(parts);
}
