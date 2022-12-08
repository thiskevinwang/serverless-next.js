import { ApiManifest, PageManifest } from "@sls-next/core/src/types";

import type {
  CloudFrontEvent,
  CloudFrontRequest,
  CloudFrontResponse,
} from "aws-lambda";

export { ImageConfig, ImagesManifest } from "@sls-next/core/src/build/types";
export { RoutesManifest } from "@sls-next/core/src/types";

export type OriginRequestApiHandlerManifest = ApiManifest & {
  enableHTTPCompression?: boolean;
};

export type OriginRequestDefaultHandlerManifest = PageManifest & {
  logLambdaExecutionTimes?: boolean;
  enableHTTPCompression?: boolean;
  regenerationQueueName?: string;
  disableOriginResponseHandler?: boolean;
};

export type OriginRequestImageHandlerManifest = {
  enableHTTPCompression?: boolean;
  domainRedirects?: {
    [key: string]: string;
  };
};

export type OriginRequestEvent = {
  Records: [
    { cf: { request: CloudFrontRequest; config: CloudFrontEvent["config"] } },
  ];
};

export type OriginResponseEvent = {
  Records: [
    {
      cf: {
        request: CloudFrontRequest;
        response: CloudFrontResponse;
        config: CloudFrontEvent["config"];
      };
    },
  ];
};

export interface RegenerationEvent {
  pagePath: string;
  basePath: string | undefined;
  region: string;
  bucketName: string;
  pageS3Path: string;
  cloudFrontEventRequest: AWSLambda.CloudFrontRequest;
}
