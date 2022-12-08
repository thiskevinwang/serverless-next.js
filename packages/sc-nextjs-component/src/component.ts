import { Component } from "@serverless/core";
import { readJSON, pathExists } from "fs-extra";
import { resolve, join } from "path";
import { Builder } from "@sls-next/lambda-at-edge";
import type {
  OriginRequestDefaultHandlerManifest as BuildManifest,
  OriginRequestDefaultHandlerManifest,
  OriginRequestApiHandlerManifest,
  RoutesManifest,
  OriginRequestImageHandlerManifest
} from "@sls-next/lambda-at-edge";
import {
  deleteOldStaticAssets,
  uploadStaticAssetsFromBuild
} from "@sls-next/s3-static-assets";
import {
  createInvalidation,
  checkCloudFrontDistributionReady
} from "@sls-next/cloudfront";
import obtainDomains from "./lib/obtainDomains";
import {
  DEFAULT_LAMBDA_CODE_DIR,
  API_LAMBDA_CODE_DIR,
  IMAGE_LAMBDA_CODE_DIR,
  REGENERATION_LAMBDA_CODE_DIR
} from "./constants";
import type {
  BuildOptions,
  ServerlessComponentInputs,
  LambdaType,
  LambdaInput
} from "../types";
import { execSync } from "child_process";
import AWS from "aws-sdk";
import { removeLambdaVersions } from "@sls-next/aws-lambda/dist/removeLambdaVersions";
// Message when deployment is explicitly skipped
const SKIPPED_DEPLOY = "SKIPPED_DEPLOY";

export type DeploymentResult = {
  appUrl: string;
  bucketName: string;
  distributionId: string;
};

class NextjsComponent extends Component {
  async default(
    inputs: ServerlessComponentInputs = {}
  ): Promise<DeploymentResult> {
    this.initialize();

    if (inputs.build !== false) {
      await this.build(inputs);
      this.postBuild(inputs);
    }

    return this.deploy(inputs);
  }

  initialize(): void {
    // Improve stack trace by increasing number of lines shown
    if (this.context.instance.debugMode) {
      Error.stackTraceLimit = 100;
    }

    // Configure AWS retry policy
    if (AWS?.config) {
      AWS.config.update({
        maxRetries: parseInt(process.env.SLS_NEXT_MAX_RETRIES ?? "10"),
        retryDelayOptions: { base: 200 }
      });
    }
  }

  readDefaultBuildManifest(
    nextConfigPath: string
  ): Promise<OriginRequestDefaultHandlerManifest> {
    return readJSON(
      join(nextConfigPath, ".serverless_nextjs/default-lambda/manifest.json")
    );
  }

  readRoutesManifest(nextConfigPath: string): Promise<RoutesManifest> {
    return readJSON(join(nextConfigPath, ".next/routes-manifest.json"));
  }

  pathPattern(pattern: string, routesManifest: RoutesManifest): string {
    const basePath = routesManifest.basePath;
    return basePath && basePath.length > 0
      ? `${basePath.slice(1)}/${pattern}`
      : pattern;
  }

  validatePathPatterns(
    pathPatterns: string[],
    buildManifest: BuildManifest,
    routesManifest: RoutesManifest
  ): void {
    const stillToMatch = new Set(pathPatterns);

    if (stillToMatch.size !== pathPatterns.length) {
      throw Error("Duplicate path declared in cloudfront configuration");
    }

    // there wont be pages for these paths for this so we can remove them
    stillToMatch.delete(this.pathPattern("api/*", routesManifest));
    stillToMatch.delete(this.pathPattern("static/*", routesManifest));
    stillToMatch.delete(this.pathPattern("_next/static/*", routesManifest));
    stillToMatch.delete(this.pathPattern("_next/data/*", routesManifest));
    stillToMatch.delete(this.pathPattern("_next/image*", routesManifest));

    // check for other api like paths
    for (const path of stillToMatch) {
      if (/^(\/?api\/.*|\/?api)$/.test(path)) {
        stillToMatch.delete(path);
      }
    }

    // setup containers for the paths we're going to be matching against

    // for dynamic routes
    const manifestRegex: RegExp[] = [];

    // for static routes
    const manifestPaths = new Set();

    // extract paths to validate against from build manifest
    const dynamic = buildManifest.pages.dynamic || [];
    const ssrNonDynamic = buildManifest.pages.ssr.nonDynamic || {};
    const htmlNonDynamic = buildManifest.pages.html.nonDynamic || {};

    // dynamic paths to check. We use their regex to match against our input yaml
    dynamic.map(({ regex }) => {
      manifestRegex.push(new RegExp(regex));
    });

    // static paths to check
    Object.entries({
      ...ssrNonDynamic,
      ...htmlNonDynamic
    }).map(([path]) => {
      manifestPaths.add(path);
    });

    // first we check if the path patterns match any of the dynamic page regex.
    // paths with stars (*) shouldn't cause any issues because the regex will treat these
    // as characters.
    manifestRegex.forEach((re) => {
      for (const path of stillToMatch) {
        if (re.test(path)) {
          stillToMatch.delete(path);
        }
      }
    });

    // now we check the remaining unmatched paths against the non dynamic paths
    // and use the path as regex so that we are testing *
    for (const pathToMatch of stillToMatch) {
      for (const path of manifestPaths) {
        if (new RegExp(pathToMatch).test(path as string)) {
          stillToMatch.delete(pathToMatch);
        }
      }
    }

    if (stillToMatch.size > 0) {
      this.context.debug(
        "There are other CloudFront path inputs that are not next.js pages, which will be added as custom behaviors."
      );
    }
  }

  async readApiBuildManifest(
    nextConfigPath: string
  ): Promise<OriginRequestApiHandlerManifest> {
    const path = join(
      nextConfigPath,
      ".serverless_nextjs/api-lambda/manifest.json"
    );

    return (await pathExists(path))
      ? readJSON(path)
      : Promise.resolve(undefined);
  }

  async readImageBuildManifest(
    nextConfigPath: string
  ): Promise<OriginRequestImageHandlerManifest> {
    const path = join(
      nextConfigPath,
      ".serverless_nextjs/image-lambda/manifest.json"
    );

    return (await pathExists(path))
      ? readJSON(path)
      : Promise.resolve(undefined);
  }

  async build(inputs: ServerlessComponentInputs = {}): Promise<void> {
    const nextConfigPath = inputs.nextConfigDir
      ? resolve(inputs.nextConfigDir)
      : process.cwd();

    const nextStaticPath = inputs.nextStaticDir
      ? resolve(inputs.nextStaticDir)
      : nextConfigPath;

    const buildCwd =
      typeof inputs.build === "boolean" ||
      typeof inputs.build === "undefined" ||
      !inputs.build.cwd
        ? nextConfigPath
        : resolve(inputs.build.cwd);

    const buildBaseDir =
      typeof inputs.build === "boolean" ||
      typeof inputs.build === "undefined" ||
      !inputs.build.baseDir
        ? nextConfigPath
        : resolve(inputs.build.baseDir);

    const buildConfig: BuildOptions = {
      enabled: inputs.build
        ? // @ts-ignore
          inputs.build !== false && // @ts-ignore
          inputs.build.enabled !== false && // @ts-ignore
          inputs.build.enabled !== "false"
        : true,
      cmd: "node_modules/.bin/next",
      args: ["build"],
      ...(typeof inputs.build === "object" ? inputs.build : {}),
      cwd: buildCwd,
      baseDir: buildBaseDir, // @ts-ignore
      cleanupDotNext: inputs.build?.cleanupDotNext ?? true
    };

    if (buildConfig.enabled) {
      const builder = new Builder(
        nextConfigPath,
        join(nextConfigPath, ".serverless_nextjs"),
        {
          cmd: buildConfig.cmd,
          cwd: buildConfig.cwd,
          env: buildConfig.env,
          args: buildConfig.args,
          useServerlessTraceTarget: inputs.useServerlessTraceTarget || false,
          logLambdaExecutionTimes: inputs.logLambdaExecutionTimes || false,
          domainRedirects: inputs.domainRedirects || {},
          minifyHandlers: inputs.minifyHandlers || false,
          enableHTTPCompression: false,
          handler: inputs.handler
            ? `${inputs.handler.split(".")[0]}.js`
            : undefined,
          authentication: inputs.authentication ?? undefined,
          baseDir: buildConfig.baseDir,
          cleanupDotNext: buildConfig.cleanupDotNext,
          assetIgnorePatterns: buildConfig.assetIgnorePatterns,
          regenerationQueueName: inputs.sqs?.name,
          separateApiLambda: buildConfig.separateApiLambda ?? true,
          disableOriginResponseHandler:
            buildConfig.disableOriginResponseHandler ?? false,
          useV2Handler: buildConfig.useV2Handler ?? false
        },
        nextStaticPath
      );

      await builder.build(this.context.instance.debugMode);
    }
  }

  /**
   * Run any post-build steps synchronously.
   * Useful to run any custom commands before deploying.
   * @param inputs
   */
  postBuild(inputs: ServerlessComponentInputs): void {
    const buildOptions = inputs.build;

    const postBuildCommands =
      (buildOptions as BuildOptions)?.postBuildCommands ?? [];

    for (const command of postBuildCommands) {
      execSync(command, { stdio: "inherit" });
    }
  }

  async deploy(
    inputs: ServerlessComponentInputs = {}
  ): Promise<DeploymentResult> {
    // Skip deployment if user explicitly set deploy input to false.
    // Useful when they just want the build outputs to deploy themselves.
    if (inputs.deploy === "false" || inputs.deploy === false) {
      return {
        appUrl: SKIPPED_DEPLOY,
        bucketName: SKIPPED_DEPLOY,
        distributionId: SKIPPED_DEPLOY
      };
    }

    const nextConfigPath = inputs.nextConfigDir
      ? resolve(inputs.nextConfigDir)
      : process.cwd();

    const nextStaticPath = inputs.nextStaticDir
      ? resolve(inputs.nextStaticDir)
      : nextConfigPath;

    const {
      defaults: cloudFrontDefaultsInputs,
      origins: cloudFrontOriginsInputs,
      aliases: cloudFrontAliasesInputs,
      priceClass: cloudFrontPriceClassInputs,
      errorPages: cloudFrontErrorPagesInputs,
      distributionId: cloudFrontDistributionId = null,
      comment: cloudFrontComment,
      webACLId: cloudFrontWebACLId,
      restrictions: cloudFrontRestrictions,
      certificate: cloudFrontCertificate,
      originAccessIdentityId: cloudFrontOriginAccessIdentityId,
      paths: cloudFrontPaths,
      waitBeforeInvalidate: cloudFrontWaitBeforeInvalidate = true,
      tags: cloudFrontTags,
      ...cloudFrontOtherInputs
    } = inputs.cloudfront || {};

    const bucketRegion = inputs.bucketRegion || "us-east-1";

    const [
      defaultBuildManifest,
      apiBuildManifest,
      imageBuildManifest,
      routesManifest
    ] = await Promise.all([
      this.readDefaultBuildManifest(nextConfigPath),
      this.readApiBuildManifest(nextConfigPath),
      this.readImageBuildManifest(nextConfigPath),
      this.readRoutesManifest(nextConfigPath)
    ]);

    const [
      bucket,
      cloudFront,
      sqs,
      defaultEdgeLambda,
      apiEdgeLambda,
      imageEdgeLambda,
      regenerationLambda
    ] = await Promise.all([
      this.load("@sls-next/aws-s3"),
      this.load("@sls-next/aws-cloudfront"),
      this.load("@sls-next/aws-sqs"),
      this.load("@sls-next/aws-lambda", "defaultEdgeLambda"),
      this.load("@sls-next/aws-lambda", "apiEdgeLambda"),
      this.load("@sls-next/aws-lambda", "imageEdgeLambda"),
      this.load("@sls-next/aws-lambda", "regenerationLambda")
    ]);

    const bucketOutputs = await bucket({
      accelerated: inputs.enableS3Acceleration ?? true,
      name: inputs.bucketName,
      region: bucketRegion,
      tags: inputs.bucketTags
    });

    // If new BUILD_ID file is present, remove all versioned assets but the existing build ID's assets, to save S3 storage costs.
    // After deployment, only the new and previous build ID's assets are present. We still need previous build assets as it takes time to propagate the Lambda.
    await deleteOldStaticAssets({
      bucketName: bucketOutputs.name,
      bucketRegion: bucketRegion,
      basePath: routesManifest.basePath,
      credentials: this.context.credentials.aws
    });

    await uploadStaticAssetsFromBuild({
      bucketName: bucketOutputs.name,
      bucketRegion: bucketRegion,
      basePath: routesManifest.basePath,
      nextConfigDir: nextConfigPath,
      nextStaticDir: nextStaticPath,
      credentials: this.context.credentials.aws,
      publicDirectoryCache: inputs.publicDirectoryCache
    });

    const bucketUrl = `http://${bucketOutputs.name}.s3.${bucketRegion}.amazonaws.com`;

    // if origin is relative path then prepend the bucketUrl
    // e.g. /path => http://bucket.s3.aws.com/path
    const expandRelativeUrls = (origin: string | Record<string, unknown>) => {
      const originUrl =
        typeof origin === "string" ? origin : (origin.url as string);
      const fullOriginUrl =
        originUrl.charAt(0) === "/" ? `${bucketUrl}${originUrl}` : originUrl;

      if (typeof origin === "string") {
        return fullOriginUrl;
      } else {
        return {
          ...origin,
          url: fullOriginUrl
        };
      }
    };

    // parse origins from inputs
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let inputOrigins: any[] = [];
    if (cloudFrontOriginsInputs) {
      const origins = cloudFrontOriginsInputs as string[];
      inputOrigins = origins.map(expandRelativeUrls);
    }

    const cloudFrontOrigins = [
      {
        url: bucketUrl,
        private: true,
        pathPatterns: {}
      },
      ...inputOrigins
    ];

    cloudFrontOrigins[0].pathPatterns[
      this.pathPattern("_next/static/*", routesManifest)
    ] = {
      minTTL: 0,
      defaultTTL: 86400,
      maxTTL: 31536000,
      forward: {
        headers: "none",
        cookies: "none",
        queryString: false
      }
    };

    cloudFrontOrigins[0].pathPatterns[
      this.pathPattern("static/*", routesManifest)
    ] = {
      minTTL: 0,
      defaultTTL: 86400,
      maxTTL: 31536000,
      forward: {
        headers: "none",
        cookies: "none",
        queryString: false
      }
    };

    const buildOptions = (inputs.build ?? {}) as BuildOptions;
    const hasSeparateApiLambdaOption =
      (!buildOptions.useV2Handler && buildOptions.separateApiLambda) ?? true; // using v2 handler automatically combines the handlers

    const hasSeparateAPIPages =
      hasSeparateApiLambdaOption &&
      apiBuildManifest &&
      (Object.keys(apiBuildManifest.apis.nonDynamic).length > 0 ||
        Object.keys(apiBuildManifest.apis.dynamic).length > 0);

    const hasConsolidatedApiPages =
      !hasSeparateApiLambdaOption && defaultBuildManifest.hasApiPages;

    const hasISRPages = Object.keys(
      defaultBuildManifest.pages.ssg.nonDynamic
    ).some(
      (key) =>
        typeof defaultBuildManifest.pages.ssg.nonDynamic[key]
          .initialRevalidateSeconds === "number"
    );

    const hasDynamicISRPages = Object.keys(
      defaultBuildManifest.pages.ssg.dynamic
    ).some(
      (key) => defaultBuildManifest.pages.ssg.dynamic[key].fallback !== false
    );

    const readLambdaInputValue = (
      inputKey: "memory" | "timeout" | "name" | "runtime" | "roleArn" | "tags",
      lambdaType: LambdaType,
      defaultValue: string | number | Record<string, string> | undefined
    ): string | number | Record<string, string> | undefined => {
      const inputValue = inputs[inputKey];

      if (typeof inputValue === "string" || typeof inputValue === "number") {
        // For lambda name, we should not allow same name to be specified across all lambdas, as this can cause conflicts
        if (inputKey === "name") {
          throw new Error(
            "Name cannot be specified across all Lambdas as it will cause conflicts."
          );
        }

        return inputValue;
      }

      if (!inputValue) {
        return defaultValue;
      }

      return inputValue[lambdaType] || defaultValue;
    };

    let queue;
    if (hasISRPages || hasDynamicISRPages) {
      queue = await sqs({
        name: inputs.sqs?.name ?? `${bucketOutputs.name}.fifo`,
        deduplicationScope: "messageGroup",
        fifoThroughputLimit: "perMessageGroupId",
        visibilityTimeout: "30",
        fifoQueue: true,
        region: bucketRegion, // make sure SQS region and regeneration lambda region are the same
        tags: inputs.sqs?.tags
      });
    }

    // default policy
    const defaultLambdaPolicy: Record<string, unknown> = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Resource: "*",
          Action: [
            "logs:CreateLogGroup",
            "logs:CreateLogStream",
            "logs:PutLogEvents"
          ]
        },
        {
          Effect: "Allow",
          Resource: `arn:aws:s3:::${bucketOutputs.name}/*`,
          Action: ["s3:GetObject", "s3:PutObject"]
        },
        ...(queue
          ? [
              {
                Effect: "Allow",
                Resource: queue.arn,
                Action: ["sqs:SendMessage"]
              }
            ]
          : [])
      ]
    };

    let policy = defaultLambdaPolicy;
    if (inputs.policy) {
      if (typeof inputs.policy === "string") {
        policy = { arn: inputs.policy };
      } else {
        policy = inputs.policy;
      }
    }

    let regenerationLambdaResult = undefined;
    if (hasISRPages || hasDynamicISRPages) {
      const regenerationLambdaInput: LambdaInput = {
        region: bucketRegion, // make sure SQS region and regeneration lambda region are the same
        description: inputs.description
          ? `${inputs.description} (Regeneration)`
          : "Next.js Regeneration Lambda",
        handler: inputs.handler || "index.handler",
        code: join(nextConfigPath, REGENERATION_LAMBDA_CODE_DIR),
        role: readLambdaInputValue("roleArn", "regenerationLambda", undefined)
          ? {
              arn: readLambdaInputValue(
                "roleArn",
                "regenerationLambda",
                undefined
              ) as string
            }
          : {
              service: ["lambda.amazonaws.com"],
              policy: {
                ...defaultLambdaPolicy,
                Statement: [
                  ...(defaultLambdaPolicy.Statement as Record<
                    string,
                    unknown
                  >[]),
                  {
                    Effect: "Allow",
                    Resource: queue.arn,
                    Action: [
                      "sqs:ReceiveMessage",
                      "sqs:DeleteMessage",
                      "sqs:GetQueueAttributes"
                    ]
                  }
                ]
              }
            },
        memory: readLambdaInputValue(
          "memory",
          "regenerationLambda",
          512
        ) as number,
        timeout: readLambdaInputValue(
          "timeout",
          "regenerationLambda",
          10
        ) as number,
        runtime: readLambdaInputValue(
          "runtime",
          "regenerationLambda",
          "nodejs14.x"
        ) as string,
        name: readLambdaInputValue(
          "name",
          "regenerationLambda",
          bucketOutputs.name
        ) as string,
        tags: readLambdaInputValue(
          "tags",
          "regenerationLambda",
          undefined
        ) as Record<string, string>
      };

      regenerationLambdaResult = await regenerationLambda(
        regenerationLambdaInput
      );

      await regenerationLambda.publishVersion();

      await sqs.addEventSource(regenerationLambdaResult.name);
    }

    let apiEdgeLambdaOutputs = undefined;

    // Only upload separate API lambda + set cache behavior if api-lambda directory is populated
    if (hasSeparateAPIPages) {
      const apiEdgeLambdaInput: LambdaInput = {
        description: inputs.description
          ? `${inputs.description} (API)`
          : "API Lambda@Edge for Next CloudFront distribution",
        handler: inputs.handler || "index.handler",
        code: join(nextConfigPath, API_LAMBDA_CODE_DIR),
        role: readLambdaInputValue("roleArn", "apiLambda", undefined)
          ? {
              arn: readLambdaInputValue(
                "roleArn",
                "apiLambda",
                undefined
              ) as string
            }
          : {
              service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
              policy
            },
        memory: readLambdaInputValue("memory", "apiLambda", 512) as number,
        timeout: readLambdaInputValue("timeout", "apiLambda", 10) as number,
        runtime: readLambdaInputValue(
          "runtime",
          "apiLambda",
          "nodejs14.x"
        ) as string,
        name: readLambdaInputValue("name", "apiLambda", undefined) as
          | string
          | undefined,
        tags: readLambdaInputValue("tags", "apiLambda", undefined) as Record<
          string,
          string
        >
      };

      apiEdgeLambdaOutputs = await apiEdgeLambda(apiEdgeLambdaInput);

      const apiEdgeLambdaPublishOutputs = await apiEdgeLambda.publishVersion();

      cloudFrontOrigins[0].pathPatterns[
        this.pathPattern("api/*", routesManifest)
      ] = {
        minTTL: 0,
        defaultTTL: 0,
        maxTTL: 31536000,
        allowedHttpMethods: [
          "HEAD",
          "DELETE",
          "POST",
          "GET",
          "OPTIONS",
          "PUT",
          "PATCH"
        ],
        forward: {
          headers: routesManifest.i18n
            ? ["Accept-Language", "Authorization", "Host"]
            : ["Authorization", "Host"],
          cookies: "all",
          queryString: true
        },
        // lambda@edge key is last and therefore cannot be overridden
        "lambda@edge": {
          "origin-request": `${apiEdgeLambdaOutputs.arn}:${apiEdgeLambdaPublishOutputs.version}`
        }
      };
    }

    let imageEdgeLambdaOutputs = undefined;

    if (imageBuildManifest) {
      const imageEdgeLambdaInput: LambdaInput = {
        description: inputs.description
          ? `${inputs.description} (Image)`
          : "Image Lambda@Edge for Next CloudFront distribution",
        handler: inputs.handler || "index.handler",
        code: join(nextConfigPath, IMAGE_LAMBDA_CODE_DIR),
        role: readLambdaInputValue("roleArn", "imageLambda", undefined)
          ? {
              arn: readLambdaInputValue(
                "roleArn",
                "imageLambda",
                undefined
              ) as string
            }
          : {
              service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
              policy
            },
        memory: readLambdaInputValue("memory", "imageLambda", 512) as number,
        timeout: readLambdaInputValue("timeout", "imageLambda", 10) as number,
        runtime: readLambdaInputValue(
          "runtime",
          "imageLambda",
          "nodejs14.x"
        ) as string,
        name: readLambdaInputValue("name", "imageLambda", undefined) as
          | string
          | undefined,
        tags: readLambdaInputValue("tags", "imageLambda", undefined) as Record<
          string,
          string
        >
      };

      imageEdgeLambdaOutputs = await imageEdgeLambda(imageEdgeLambdaInput);

      const imageEdgeLambdaPublishOutputs =
        await imageEdgeLambda.publishVersion();

      cloudFrontOrigins[0].pathPatterns[
        this.pathPattern("_next/image*", routesManifest)
      ] = {
        minTTL: 0,
        defaultTTL: 60,
        maxTTL: 31536000,
        allowedHttpMethods: [
          "HEAD",
          "DELETE",
          "POST",
          "GET",
          "OPTIONS",
          "PUT",
          "PATCH"
        ],
        forward: {
          headers: ["Accept"]
        },
        "lambda@edge": {
          "origin-request": `${imageEdgeLambdaOutputs.arn}:${imageEdgeLambdaPublishOutputs.version}`
        }
      };
    }

    const defaultEdgeLambdaInput: LambdaInput = {
      description:
        inputs.description ||
        "Default Lambda@Edge for Next CloudFront distribution",
      handler: inputs.handler || "index.handler",
      code: join(nextConfigPath, DEFAULT_LAMBDA_CODE_DIR),
      role: readLambdaInputValue("roleArn", "defaultLambda", undefined)
        ? {
            arn: readLambdaInputValue(
              "roleArn",
              "defaultLambda",
              undefined
            ) as string
          }
        : {
            service: ["lambda.amazonaws.com", "edgelambda.amazonaws.com"],
            policy
          },
      memory: readLambdaInputValue("memory", "defaultLambda", 512) as number,
      timeout: readLambdaInputValue("timeout", "defaultLambda", 10) as number,
      runtime: readLambdaInputValue(
        "runtime",
        "defaultLambda",
        "nodejs14.x"
      ) as string,
      name: readLambdaInputValue("name", "defaultLambda", undefined) as
        | string
        | undefined,
      tags: readLambdaInputValue("tags", "defaultLambda", undefined) as Record<
        string,
        string
      >
    };

    const defaultEdgeLambdaOutputs = await defaultEdgeLambda(
      defaultEdgeLambdaInput
    );

    const defaultEdgeLambdaPublishOutputs =
      await defaultEdgeLambda.publishVersion();

    cloudFrontOrigins[0].pathPatterns[
      this.pathPattern("_next/data/*", routesManifest)
    ] = {
      minTTL: 0,
      defaultTTL: 0,
      maxTTL: 31536000,
      allowedHttpMethods: ["HEAD", "GET"],
      forward: {
        cookies: "all",
        headers: ["Authorization", "Host"],
        queryString: true
      },
      "lambda@edge": buildOptions.disableOriginResponseHandler
        ? {
            "origin-request": `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`
          }
        : {
            "origin-request": `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`,
            "origin-response": `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`
          }
    };

    // If we are using consolidated API pages (within default lambda), we need to ensure api/* behavior is set correctly.
    // Note that if there are no consolidated API pages then existing api/* is not deleted.
    // We do so for a couple reasons:
    // 1. API pages don't need origin response handler as it's not retrieving from S3 origin
    // 2. Override existing api/* behavior to ensure old separate API lambda isn't there
    if (hasConsolidatedApiPages) {
      cloudFrontOrigins[0].pathPatterns[
        this.pathPattern("api/*", routesManifest)
      ] = {
        minTTL: 0,
        defaultTTL: 0,
        maxTTL: 31536000,
        allowedHttpMethods: [
          "HEAD",
          "DELETE",
          "POST",
          "GET",
          "OPTIONS",
          "PUT",
          "PATCH"
        ],
        forward: {
          headers: routesManifest.i18n
            ? ["Accept-Language", "Authorization", "Host"]
            : ["Authorization", "Host"],
          cookies: "all",
          queryString: true
        },
        // lambda@edge key is last and therefore cannot be overridden
        "lambda@edge": {
          "origin-request": `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`
        }
      };
    }

    // validate that the custom config paths match generated paths in the manifest
    this.validatePathPatterns(
      Object.keys(cloudFrontOtherInputs),
      defaultBuildManifest,
      routesManifest
    );

    // Add any custom cloudfront configuration
    // this includes overrides for _next/data/*, _next/static/*, static/*, api/*, and default cache behaviors
    Object.entries(cloudFrontOtherInputs).map(([path, config]) => {
      const edgeConfig = {
        ...(config["lambda@edge"] || {})
      };

      // here we are removing configs that cannot be overridden
      if (
        path === this.pathPattern("api/*", routesManifest) ||
        path === this.pathPattern("_next/image*", routesManifest)
      ) {
        // for "api/*" or "_next/image*" we need to make sure we aren't overriding the predefined lambda handler
        // Since these are using special API or Image handlers
        // delete is idempotent so it's safe
        delete edgeConfig["origin-request"];
      } else if (!["static/*", "_next/static/*", "_next/*"].includes(path)) {
        // for everything but _next/static/*, static/* and _next/* we want to ensure that they are pointing at the default lambda
        edgeConfig[
          "origin-request"
        ] = `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`;
      }

      cloudFrontOrigins[0].pathPatterns[path] = {
        // spread the existing value if there is one
        ...cloudFrontOrigins[0].pathPatterns[path],
        // spread custom config
        ...config,
        "lambda@edge": {
          // spread the provided value
          ...(cloudFrontOrigins[0].pathPatterns[path] &&
            cloudFrontOrigins[0].pathPatterns[path]["lambda@edge"]),
          // then overrides
          ...edgeConfig
        }
      };
    });

    // make sure that origin-response is not set.
    // this is reserved for serverless-next.js usage
    const cloudFrontDefaults = cloudFrontDefaultsInputs || {};

    const defaultLambdaAtEdgeConfig = {
      ...(cloudFrontDefaults["lambda@edge"] || {})
    };
    delete defaultLambdaAtEdgeConfig["origin-response"];

    const cloudFrontOutputs = await cloudFront({
      bucketRegion: bucketRegion,
      distributionId: cloudFrontDistributionId,
      defaults: {
        minTTL: 0,
        defaultTTL: 0,
        maxTTL: 31536000,
        ...cloudFrontDefaults,
        forward: {
          headers: routesManifest.i18n
            ? ["Accept-Language", "Authorization", "Host"]
            : ["Authorization", "Host"],
          cookies: "all",
          queryString: true,
          ...cloudFrontDefaults.forward
        },
        // everything after here cant be overridden
        allowedHttpMethods: [
          "HEAD",
          "DELETE",
          "POST",
          "GET",
          "OPTIONS",
          "PUT",
          "PATCH"
        ],
        "lambda@edge": buildOptions.disableOriginResponseHandler
          ? {
              ...defaultLambdaAtEdgeConfig,
              "origin-request": `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`
            }
          : {
              ...defaultLambdaAtEdgeConfig,
              "origin-request": `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`,
              "origin-response": `${defaultEdgeLambdaOutputs.arn}:${defaultEdgeLambdaPublishOutputs.version}`
            },
        compress: true
      },
      origins: cloudFrontOrigins,
      ...(cloudFrontAliasesInputs && {
        aliases: cloudFrontAliasesInputs
      }),
      ...(cloudFrontPriceClassInputs && {
        priceClass: cloudFrontPriceClassInputs
      }),
      ...(cloudFrontErrorPagesInputs && {
        errorPages: cloudFrontErrorPagesInputs
      }),
      comment: cloudFrontComment,
      webACLId: cloudFrontWebACLId,
      restrictions: cloudFrontRestrictions,
      certificate: cloudFrontCertificate,
      originAccessIdentityId: cloudFrontOriginAccessIdentityId,
      tags: cloudFrontTags
    });

    let appUrl = cloudFrontOutputs.url;

    const distributionId = cloudFrontOutputs.id;
    if (!cloudFrontPaths || cloudFrontPaths.length) {
      // We need to wait for distribution to be fully propagated before trying to invalidate paths, otherwise we may cache old page
      // This could add ~1-2 minute to deploy time but it is safer
      const waitDuration = 600;
      const pollInterval = 10;
      if (cloudFrontWaitBeforeInvalidate) {
        this.context.debug(
          `Waiting for CloudFront distribution ${distributionId} to be ready before invalidations, for up to ${waitDuration} seconds, checking every ${pollInterval} seconds.`
        );
        await checkCloudFrontDistributionReady({
          distributionId: distributionId,
          credentials: this.context.credentials.aws,
          waitDuration: waitDuration,
          pollInterval: pollInterval
        });
      } else {
        this.context.debug(
          `Skipped waiting for CloudFront distribution ${distributionId} to be ready.`
        );
      }

      this.context.debug(`Creating invalidations on ${distributionId}.`);
      await createInvalidation({
        distributionId: distributionId,
        credentials: this.context.credentials.aws,
        paths: cloudFrontPaths
      });
    } else {
      this.context.debug(`No invalidations needed for ${distributionId}.`);
    }

    const { domain, subdomain } = obtainDomains(inputs.domain);
    if (domain && subdomain) {
      const domainComponent = await this.load("@sls-next/domain");
      const domainOutputs = await domainComponent({
        privateZone: false,
        domain,
        subdomains: {
          [subdomain]: cloudFrontOutputs
        },
        domainType: inputs.domainType || "both",
        defaultCloudfrontInputs: cloudFrontDefaults,
        certificateArn: inputs.certificateArn,
        domainMinimumProtocolVersion: inputs.domainMinimumProtocolVersion
      });
      appUrl = domainOutputs.domains[0];
    }

    // Remove old lambda function versions if specified to save on code space
    if (inputs.removeOldLambdaVersions) {
      this.context.debug("Removing old lambda versions...");
      await Promise.all([
        await removeLambdaVersions(
          this.context,
          defaultEdgeLambdaOutputs.arn,
          defaultEdgeLambdaOutputs.region
        ),
        apiEdgeLambdaOutputs
          ? await removeLambdaVersions(
              this.context,
              apiEdgeLambdaOutputs.arn,
              apiEdgeLambdaOutputs.region
            )
          : Promise.resolve(),
        imageEdgeLambdaOutputs
          ? await removeLambdaVersions(
              this.context,
              imageEdgeLambdaOutputs.arn,
              imageEdgeLambdaOutputs.region
            )
          : Promise.resolve(),
        regenerationLambdaResult
          ? await removeLambdaVersions(
              this.context,
              regenerationLambdaResult.arn,
              regenerationLambdaResult.region
            )
          : Promise.resolve()
      ]);
    }

    return {
      appUrl,
      bucketName: bucketOutputs.name,
      distributionId: cloudFrontOutputs.id
    };
  }

  async remove(): Promise<void> {
    const [bucket, cloudfront, sqs, domain] = await Promise.all([
      this.load("@sls-next/aws-s3"),
      this.load("@sls-next/aws-cloudfront"),
      this.load("@sls-next/aws-sqs"),
      this.load("@sls-next/domain")
    ]);

    await bucket.remove();
    await cloudfront.remove();
    await domain.remove();
    await sqs.remove();
  }
}

export default NextjsComponent;
