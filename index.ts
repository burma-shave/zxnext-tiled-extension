/// <reference types="@mapeditor/tiled-api" />
import bitwise from "bitwise";
import * as _ from "lodash";
import extract from "png-chunks-extract";
import pako from "pako";

// output tilemap in zx next format
// subtile id translation
// zxNexttileId = tiledId - 1
// zxNextTileId = zxNextTileId < 0 ? 0 : zxNextTileId;

type MetaTileSpec = {
  tileId: number;
  subTileCoords: number[];
  xMirror: boolean;
  yMirror: boolean;
  rotate: boolean;
  //rect: rect;
  //tileSetName: string;
};

const exportMap = (map, fileName) => {
  const file = new TextFile(fileName, TextFile.WriteOnly);

  const metatTileMap: MetaTileSpec[] = [];
  tiled.log("Map height: " + map.height);
  tiled.log("Map width: " + map.width);

  // ZX Spectrum Next layer 3 tile size is 8x8 pixels
  // This extension allows you to use any tile size in Tiled.
  // The tile used in tiled is referred to a as meta tile.
  // A meta tile is split into a number of substiles that correspond to the
  // 8x8 pixel tiles used by the ZX Spectrum Next layer 3.
  // The number of substiles is determined by the tile size of the meta tile.
  // For example a 16x16 meta tile is split into 4 substiles.
  // A 32x32 meta tile is split into 16 substiles.
  // The substiles are read from the meta tile in a left to right, top to bottom
  // order.
  // The tile as used in Tiled is referred to as a meta tile.
  // The metaTileFactor is the number of substiles in a meta tile.
  const metaTileFactor = map.tileWidth / 8;
  tiled.log("metaTileFactor: " + metaTileFactor);

  if (map.layerCount === 0) return "No layers to export";

  // TODO: support multiple tile layers
  const firstLayer = map.layers[0];

  if (firstLayer.isTileLayer) {
    const tileLayer = firstLayer as TileLayer;
    // Output details of each tile in the map.
    // The tile id is the id of the tile as used in Tiled.
    // The subTileCoords are the x and y coordinates of the subtile within the
    // meta tile. In a 16x16 meta tile the subtile coordinates are 0,0, 1,0, 0,1.
    for (var j = 0; j < map.height; j++) {
      for (var metaTileRow = 0; metaTileRow < metaTileFactor; metaTileRow++) {
        for (var i = 0; i < map.width; i++) {
          for (
            var metaTileColumn = 0;
            metaTileColumn < metaTileFactor;
            metaTileColumn++
          ) {
            const tile = tileLayer.tileAt(i, j);

            if (!tile) {
              tiled.log("No tile found at " + i + ", " + j);
            }

            const cell = tileLayer.cellAt(i, j);

            //@ts-ignore
            //const rect = tile?.imageRect as rect;

            const tiledTileId = tileLayer.tileAt(i, j)?.id;
            let tileId = tiledTileId;

            // TODO: convert tileId into tileattribute index, assume 1 tileset per layer

            metatTileMap.push({
              tileId: tileId,
              subTileCoords: [metaTileColumn, metaTileRow],
              xMirror:
                (cell.flippedVertically && cell.flippedAntiDiagonally) ||
                (cell.flippedHorizontally && !cell.flippedAntiDiagonally),
              yMirror:
                (cell.flippedVertically && !cell.flippedAntiDiagonally) ||
                (!cell.flippedHorizontally && cell.flippedAntiDiagonally),
              rotate: cell.flippedAntiDiagonally,
              //rect: rect,
              //tileSetName: tile?.tileset.name,
            });
          }
        }
      }
    }
  } else {
    // well, we only checked the first layer so we didn't
    // try very hard!
    return "No tile layers found.";
  }

  // metaTileMap -> binry

  file.writeLine(JSON.stringify(metatTileMap));
  file.commit();
  return null;
};

const exportTileSet = (tileset, filename) => {
  if (tileset.tileWidth % 8 !== 0 || tileset.tileHeight % 8 !== 0) {
    return "Tiles must be multiple of 8 pixels in width and height";
  }
  const file = new BinaryFile(filename, BinaryFile.WriteOnly);

  tiled.log("tileCount: " + tileset.tileCount);
  tiled.log("tilesetWidth: " + tileset.imageWidth);
  tiled.log("tilesetHeight " + tileset.imageHeight);
  tiled.log(
    "expectedNumberOfPixels " + tileset.imageHeight * tileset.imageWidth
  );
  const tileReadOffsets = _.flattenDeep(subTileReadOffsets(tileset));
  tiled.log("offsets: " + tileReadOffsets.slice(0, 32));

  tiled.log("tileset.image: " + tileset.image);
  const tilesetImageFile = new BinaryFile(tileset.image, BinaryFile.ReadOnly);
  const tilesetImageFileData = new Uint8Array(tilesetImageFile.readAll());
  tilesetImageFile.close();
  tiled.log("image file lengrh: " + tilesetImageFileData.byteLength);
  const pngChunks = extract(tilesetImageFileData);
  // TODO: validate png file, indexed colour, 8 bit depth etc
  tiled.log("pngChunks " + JSON.stringify(pngChunks.map((c) => c.name)));

  const dataChunks = pngChunks
    .filter((c) => c.name === "IDAT")
    .map((c) => c.data);

  // TODO: combine multiple IDAT chunks
  // data in a png files is compressed using Deflate/zlib
  // https://www.w3.org/TR/png/#10Compression
  const compressedPixelData = dataChunks[0];
  const deflatedData = pako.inflate(compressedPixelData) as Uint8Array;
  tiled.log("deflatedData size: " + deflatedData.length);

  const pixelData = deflatedData
    // png divides the image into scanlines
    // in png each scanline is preceeded by a filter byte
    // the filter byte specifies how the scanline is filtered
    // the only supported filter is 0 (none)
    .filter((_, i) => i % (tileset.imageWidth + 1) !== 0);

  tiled.log("number of pixels " + pixelData.length);
  tiled.log(
    "difference: " +
      (pixelData.length - tileset.imageHeight * tileset.imageWidth)
  );
  tiled.log("first 32 pixels: " + pixelData.slice(0, 32));

  const tileData = new Uint8Array(
    new ArrayBuffer(
      tileset.tileCount * (tileset.tileHeight * tileset.tileWidth)
    )
  );
  // Calculate the offset into the tileData array for each 8x8 tile
  let bufferPosition = 0;
  tileReadOffsets.forEach((offset) => {
    const pixelDataSlice = pixelData.slice(offset, offset + 8);
    tileData.set(pixelDataSlice, bufferPosition);
    bufferPosition = bufferPosition + 8;
  });

  tiled.log("tileData : " + tileData.slice(256, 256 + 32));

  // The ZX Next layer 3 tile format is 4 bits per pixel so 16 colours
  // We normalise the pixel data to be in the range 0-15
  // Later we will use a palette offset to get back the original colours
  // The tilset should should be created so that each tile uses a contiguous
  // range of 16 colours from the palette.
  const normalizedTileData = tileData.map((pixelValue) => pixelValue % 16);
  tiled.log("normalizedTileData length: " + normalizedTileData.length);
  tiled.log("normalizedTileData: " + normalizedTileData.slice(256, 256 + 32));

  // The ZX Next layer 3 tile format is 4 bits per pixel so 16 colours
  // Two pixles are packed into a single byte, the first pixel is in the
  // lower 4 bits and the second pixel is in the upper 4 bits.
  const evenPixels = normalizedTileData.filter((_, i) => i % 2 !== 0);
  const oddPixels = normalizedTileData.filter((_, i) => i % 2 === 0);

  tiled.log("oddPixels length: " + oddPixels.length);
  tiled.log("evenPixels length: " + evenPixels.length);
  tiled.log("oddPixels: " + oddPixels.slice(128, 128 + 32));
  tiled.log("evenPixels: " + evenPixels.slice(128, 128 + 32));

  // 32 pixels per 8x8 tile - 4 bits per pixel
  const layer3TileData = new Uint8Array(new ArrayBuffer(oddPixels.length));
  for (let index = 0; index < oddPixels.length; index++) {
    layer3TileData[index] = oddPixels[index] | (evenPixels[index] << 4);
    //      layer3TileData[index] = oddPixels[index];
  }
  file.write(layer3TileData.buffer);
  file.commit();

  const paletteChunks = pngChunks
    .filter((c) => c.name === "PLTE")
    .map((c) => c.data);

  // open palette file for writing
  const paletteFile = new BinaryFile(filename + ".pal", BinaryFile.WriteOnly);

  // TODO: check palette exists
  const palette = paletteChunks[0];

  const paletteBuffer = new Uint8Array(new ArrayBuffer(palette.length / 3));
  // log each palette entry
  for (let index = 0; index < palette.length - 2; index += 3) {
    const r = palette[index];
    const g = palette[index + 1];
    const b = palette[index + 2];
    tiled.log(`palette entry ${index / 3}: ${r}, ${g}, ${b}`);

    // convert to zx next palette
    const zxR = r & 0b11100000;
    const zxG = (g & 0b11100000) >> 3;
    const zxB = (b & 0b11000000) >> 6;
    const zxColour = zxR | zxG | zxB;

    paletteBuffer[index / 3] = zxColour;
  }

  // write to file
  paletteFile.write(paletteBuffer.buffer);
  paletteFile.commit();

  // write palette data to file
  // for testing, generate simple tilemap?

  // tiled.log('offsets: ' + tileReadOffsets);
  return null;
};

/**
 * Convert raster tileset image into a sequence of pixel data for eeach tile
 * stored in sequence.
 * @returns
 */
const subTileReadOffsets = (tileset: Tileset) => {
  // load png pixel values from tileset

  const imgWidth = tileset.imageWidth;

  // number of subtiles across
  const subTileWidth = tileset.tileWidth / 8;
  // number of subtiles down
  const subTileHeight = tileset.tileHeight / 8;

  // x offsets of the beginning of each subtile
  const subTileXOffsets = _.range(subTileWidth).map((o) => o * 8);
  // y offsets of the beginning of each subtile
  const subTileYOffsets = _.range(subTileHeight).map((o) => o * 8);

  return tileset.tiles.map((tile) => {
    // go through each subtile across and the down, row major order
    return subTileYOffsets.map((subTileYOffset) => {
      return subTileXOffsets.map((subTileXOffset) => {
        //@ts-ignore
        const rect = tile.imageRect as rect;
        return _.range(0, 8).map(
          (row) =>
            (rect.y + subTileYOffset + row) * imgWidth + rect.x + subTileXOffset
        );
      });
    });
  });
};

tiled.registerTilesetFormat("next", {
  name: "ZX Next Layer 3 Tileset",
  extension: "bin",
  write: exportTileSet,
});

tiled.registerMapFormat("next", {
  name: "ZX Next Layer 3 Tilemap",
  extension: "json",
  write: exportMap,
});
