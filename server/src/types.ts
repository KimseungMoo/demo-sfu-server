export type CatalogStream = {
  streamKey: string;
  path: string;
  codec: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
};

export type Catalog = {
  streams: CatalogStream[];
};
