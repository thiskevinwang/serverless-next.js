// @ts-ignore
import manifest from "./manifest.json";
// @ts-ignore
import RoutesManifestJson from "./routes-manifest.json";
import {
  ImagesManifest,
  OriginRequestEvent,
  OriginRequestImageHandlerManifest,
  RoutesManifest
} from "./types";
import { CloudFrontResultResponse } from "aws-lambda";
import lambdaAtEdgeCompat from "@sls-next/next-aws-cloudfront";
import {
  handleAuth,
  handleDomainRedirects,
  setCustomHeaders
} from "@sls-next/core/dist/module";
import {
  imageOptimizer,
  normaliseUri
} from "@sls-next/core/dist/module/images";
import { UrlWithParsedQuery } from "url";
import url from "url";
import { removeBlacklistedHeaders } from "./headers/removeBlacklistedHeaders";
import { s3BucketNameFromEventRequest } from "./s3/s3BucketNameFromEventRequest";
import { AwsPlatformClient } from "@sls-next/aws-common";

const basePath = RoutesManifestJson.basePath;
const isImageOptimizerRequest = (uri: string): boolean =>
  uri.startsWith("/_next/image");

export const handler = async (
  event: OriginRequestEvent
): Promise<CloudFrontResultResponse> => {
  const request = event.Records[0].cf.request;
  const routesManifest: RoutesManifest = RoutesManifestJson;
  const buildManifest: OriginRequestImageHandlerManifest = manifest;

  // Handle basic auth
  const authRoute = handleAuth(request, buildManifest);
  if (authRoute) {
    const { status, ...response } = authRoute;
    return { ...response, status: status.toString() };
  }

  // Handle domain redirects e.g www to non-www domain
  const redirectRoute = handleDomainRedirects(request, manifest);
  if (redirectRoute) {
    const { status, ...response } = redirectRoute;
    return { ...response, status: status.toString() };
  }

  // No other redirects or rewrites supported for now as it's assumed one is accessing this directly.
  // But it can be added later.

  const uri = normaliseUri(request.uri, basePath);

  // Handle image optimizer requests
  const isImageRequest = isImageOptimizerRequest(uri);
  if (isImageRequest) {
    let imagesManifest: ImagesManifest | undefined;

    try {
      // @ts-ignore
      imagesManifest = await import("./images-manifest.json");
    } catch (error) {
      console.warn(
        "Images manifest not found for image optimizer request. Image optimizer will fallback to defaults."
      );
    }

    const { req, res, responsePromise } = lambdaAtEdgeCompat(
      event.Records[0].cf,
      {
        enableHTTPCompression: manifest.enableHTTPCompression
      }
    );

    const urlWithParsedQuery: UrlWithParsedQuery = url.parse(
      `${request.uri}?${request.querystring}`,
      true
    );

    const { region: bucketRegion } = request.origin!.s3!;
    const bucketName = s3BucketNameFromEventRequest(request) ?? "";

    const awsPlatformClient = new AwsPlatformClient(
      bucketName,
      bucketRegion,
      undefined,
      undefined
    );

    await imageOptimizer(
      basePath,
      imagesManifest,
      req,
      res,
      urlWithParsedQuery,
      awsPlatformClient
    );

    setCustomHeaders({ res, req, responsePromise }, routesManifest);

    const response = await responsePromise;

    if (response.headers) {
      removeBlacklistedHeaders(response.headers);
    }

    return response;
  } else {
    return {
      status: "404"
    };
  }
};
