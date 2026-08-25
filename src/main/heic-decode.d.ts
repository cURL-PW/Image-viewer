/**
 * heic-decode は型定義を同梱していないので、使う分だけ宣言する。
 * WASM 版 libheif で HEIF/HEIC を RGBA へ復号する。
 */
declare module 'heic-decode' {
  interface DecodedImage {
    width: number
    height: number
    /** RGBA 8bit のピクセル列 */
    data: Uint8ClampedArray
  }

  function decode(input: { buffer: Uint8Array }): Promise<DecodedImage>

  export = decode
}
