import fse from "fs-extra";
import { join } from "path";
import path from "path";
import { ImageBuildManifest, PageManifest } from "@sls-next/core";
import CoreBuilder from "@sls-next/core/dist/build/builder";
import { Manifest, CoreBuildOptions } from "@sls-next/core";
import { LambdaBuildOptions, LambdaManifest } from "src/types";

export const DEFAULT_LAMBDA_CODE_DIR = "default-lambda";
export const IMAGE_LAMBDA_CODE_DIR = "image-lambda";

export class LambdaBuilder extends CoreBuilder {
  protected lambdaBuildOptions: LambdaBuildOptions;

  public constructor(
    lambdaBuildOptions: LambdaBuildOptions,
    coreBuildOptions?: CoreBuildOptions
  ) {
    super(coreBuildOptions);
    this.lambdaBuildOptions = lambdaBuildOptions;
  }

  protected async buildPlatform(
    manifests: {
      imageManifest: Manifest;
      pageManifest: PageManifest;
    },
    debugMode?: boolean
  ): Promise<void> {
    const { pageManifest, imageManifest } = manifests;
    const imageBuildManifest = {
      ...imageManifest
    };

    // Build Lambda-specific manifest which will be included in the default and image handlers
    const lambdaManifest: LambdaManifest = {
      bucketName: this.lambdaBuildOptions.bucketName,
      bucketRegion: this.lambdaBuildOptions.bucketRegion,
      queueName: this.lambdaBuildOptions.queueName,
      queueRegion: this.lambdaBuildOptions.queueRegion
    };

    await this.buildDefaultLambda(pageManifest, lambdaManifest);
    // If using Next.js 10 and images-manifest.json is present then image optimizer can be used
    const hasImagesManifest = await fse.pathExists(
      join(this.dotNextDir, "images-manifest.json")
    );

    // However if using a non-default loader, the lambda is not needed
    const imagesManifest = hasImagesManifest
      ? await fse.readJSON(join(this.dotNextDir, "images-manifest.json"))
      : null;
    const imageLoader = imagesManifest?.images?.loader;
    const isDefaultLoader = !imageLoader || imageLoader === "default";
    const hasImageOptimizer = hasImagesManifest && isDefaultLoader;

    // ...nor if the image component is not used
    const exportMarker = (await fse.pathExists(
      join(this.dotNextDir, "export-marker.json")
    ))
      ? await fse.readJSON(path.join(this.dotNextDir, "export-marker.json"))
      : {};
    const isNextImageImported = exportMarker.isNextImageImported !== false;

    if (hasImageOptimizer && isNextImageImported) {
      await this.buildImageLambda(imageBuildManifest, lambdaManifest);
    }
  }

  /**
   * Process and copy handler code. This allows minifying it before copying to Lambda package.
   * @param handlerType
   * @param destination
   * @param shouldMinify
   */
  protected async processAndCopyHandler(
    handlerType: "default-handler" | "image-handler",
    destination: string,
    shouldMinify: boolean
  ): Promise<void> {
    const source = path.dirname(
      require.resolve(
        `@sls-next/lambda/dist/bundles/${handlerType}/${
          shouldMinify ? "minified" : "standard"
        }`
      )
    );

    await fse.copy(source, destination);
  }

  /**
   * Build default lambda which handles all requests as well as regeneration requests.
   * @param pageManifest
   * @param lambdaManifest
   * @private
   */
  protected async buildDefaultLambda(
    pageManifest: Manifest,
    lambdaManifest: LambdaManifest
  ): Promise<void[]> {
    const hasAPIRoutes = await fse.pathExists(
      join(this.serverlessDir, "pages/api")
    );

    await fse.mkdir(join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR));

    return Promise.all([
      this.processAndCopyHandler(
        "default-handler",
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR),
        this.buildOptions.minifyHandlers
      ),
      this.buildOptions?.handler
        ? fse.copy(
            join(this.nextConfigDir, this.buildOptions.handler),
            join(
              this.outputDir,
              DEFAULT_LAMBDA_CODE_DIR,
              this.buildOptions.handler
            )
          )
        : Promise.resolve(),
      fse.writeJson(
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "manifest.json"),
        pageManifest,
        this.buildOptions.minifyHandlers ? undefined : { spaces: 2 }
      ),
      fse.writeJson(
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "lambda-manifest.json"),
        lambdaManifest,
        this.buildOptions.minifyHandlers ? undefined : { spaces: 2 }
      ),
      fse.copy(
        join(this.serverlessDir, "pages"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "pages"),
        {
          filter: this.getDefaultHandlerFileFilter(hasAPIRoutes, pageManifest)
        }
      ),
      this.copyChunks(DEFAULT_LAMBDA_CODE_DIR),
      this.copyJSFiles(DEFAULT_LAMBDA_CODE_DIR),
      fse.copy(
        join(this.dotNextDir, "prerender-manifest.json"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "prerender-manifest.json")
      ),
      this.processAndCopyRoutesManifest(
        join(this.dotNextDir, "routes-manifest.json"),
        join(this.outputDir, DEFAULT_LAMBDA_CODE_DIR, "routes-manifest.json")
      )
    ]);
  }

  /**
   * Build image optimization lambda (supported by Next.js 10+)
   * @param imageBuildManifest
   * @param lambdaManifest
   */
  protected async buildImageLambda(
    imageBuildManifest: ImageBuildManifest,
    lambdaManifest: LambdaManifest
  ): Promise<void> {
    await fse.mkdir(join(this.outputDir, IMAGE_LAMBDA_CODE_DIR));

    await Promise.all([
      this.processAndCopyHandler(
        "image-handler",
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR),
        this.buildOptions.minifyHandlers
      ),
      this.buildOptions?.handler
        ? fse.copy(
            join(this.nextConfigDir, this.buildOptions.handler),
            join(
              this.outputDir,
              IMAGE_LAMBDA_CODE_DIR,
              this.buildOptions.handler
            )
          )
        : Promise.resolve(),
      fse.writeJson(
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "manifest.json"),
        imageBuildManifest,
        this.buildOptions.minifyHandlers ? undefined : { spaces: 2 }
      ),
      fse.writeJson(
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "lambda-manifest.json"),
        lambdaManifest,
        this.buildOptions.minifyHandlers ? undefined : { spaces: 2 }
      ),
      this.processAndCopyRoutesManifest(
        join(this.dotNextDir, "routes-manifest.json"),
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "routes-manifest.json")
      ),
      fse.copy(
        join(
          path.dirname(require.resolve("@sls-next/core/package.json")),
          "dist",
          "sharp_node_modules"
        ),
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "node_modules")
      ),
      fse.copy(
        join(this.dotNextDir, "images-manifest.json"),
        join(this.outputDir, IMAGE_LAMBDA_CODE_DIR, "images-manifest.json")
      )
    ]);
  }
}
