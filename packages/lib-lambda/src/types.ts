import { ApiManifest, PageManifest } from "@sls-next/core";
export { ImageConfig, ImagesManifest, RoutesManifest } from "@sls-next/core";

export type LambdaManifest = {
  bucketName: string;
  bucketRegion: string;
  queueName?: string;
  queueRegion?: string;
  logExecutionTimes?: boolean;
};

export type BuildManifest = ApiManifest & PageManifest;

export type PreRenderedManifest = {
  version: 3;
  routes: {
    [route: string]: {
      initialRevalidateSeconds: number | false;
      srcRoute: string | null;
      dataRoute: string;
    };
  };
  dynamicRoutes: {
    [route: string]: {
      routeRegex: string;
      fallback: string | false;
      dataRoute: string;
      dataRouteRegex: string;
    };
  };
  preview: {
    previewModeId: string;
    previewModeSigningKey: string;
    previewModeEncryptionKey: string;
  };
};

export type PerfLogger = {
  now: () => number | undefined;
  log: (metricDescription: string, t1?: number, t2?: number) => void;
};

/**
 * Build Options specific to Lambda
 */
export type LambdaBuildOptions = {
  bucketName: string;
  bucketRegion: string;
  queueName?: string;
  queueRegion?: string;
};
