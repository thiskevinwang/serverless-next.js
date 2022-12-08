import { s3StorePage } from "../../src/s3/s3StorePage";
import { jest } from "@jest/globals";

import {
  mockSend,
  mockPutObjectCommand
} from "../mocks/s3/aws-sdk-s3-client.mock2";

jest.mock("@aws-sdk/client-s3", () =>
  require("../mocks/s3/aws-sdk-s3-client.mock2")
);

describe("S3StorePage Tests", () => {
  it.each`
    basePath       | uri          | expectedKeyName
    ${undefined}   | ${"/custom"} | ${"custom"}
    ${undefined}   | ${"/"}       | ${"index"}
    ${"/basepath"} | ${"/custom"} | ${"custom"}
    ${"/basepath"} | ${"/"}       | ${"index"}
  `(
    "should store the page with basePath $basePath at path $uri with expectedKeyName $expectedKeyName",
    async ({ basePath, uri, expectedKeyName }) => {
      await s3StorePage({
        uri: uri,
        basePath: basePath,
        bucketName: "test",
        html: "test",
        buildId: "test-build-id",
        region: "us-east-1",
        pageData: {}
      });

      const s3BasePath = basePath ? `${basePath.replace(/^\//, "")}/` : "";

      expect(mockPutObjectCommand).toHaveBeenNthCalledWith(1, {
        Bucket: "test",
        Key: `${s3BasePath}_next/data/test-build-id/${expectedKeyName}.json`,
        Body: "{}",
        ContentType: "application/json",
        CacheControl: "public, max-age=0, s-maxage=2678400, must-revalidate",
        Expires: undefined
      });

      expect(mockPutObjectCommand).toHaveBeenNthCalledWith(2, {
        Bucket: "test",
        Key: `${s3BasePath}static-pages/test-build-id/${expectedKeyName}.html`,
        Body: "test",
        ContentType: "text/html",
        CacheControl: "public, max-age=0, s-maxage=2678400, must-revalidate",
        Expires: undefined
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
    }
  );
});
