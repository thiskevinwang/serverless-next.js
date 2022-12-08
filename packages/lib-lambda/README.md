# @sls-next/lambda
> Library to build and deploy Next.js apps for AWS Lambda + API Gateway

> ⚠️ This library is currently in developer preview, and may have limited functionality, bugs, and is not fully tested. The interface may also change in the near future. Use at your own risk.

This library uses the platform-agnostic handlers provided by `@sls-next/core` and wraps them with a Lambda/API Gateway-compatible layer so that Next.js apps can be served through API Gateway via a HTTP API.

For usage docs, please refer to (TBA).

## Architecture

Once built and packaged, the app consists of the following components:

* `default-lambda`: handles all requests, including pages, APIs, and regeneration requests.
* `image-lambda`: handles image optimization requests.
* `assets`: all static assets used by your app.

## Infrastructure

You will need the following infrastructure to deploy your app:

* AWS Lambda
* AWS API Gateway
* AWS S3 Bucket
* AWS SQS Queue (if you are using ISR)
* AWS CloudFront in front of your API Gateway endpoint, to help with caching, since the APIGateway infra is a HTTP API and can only be regional.
* additional roles, permissions, etc.

## Deployment

We want to empower you to own your own infrastructure code so as to give you the most flexibility for your requirements, so we provide a reference zero-config deployer, which you can easily override resource configurations:

* (WIP) CDK for Terraform deployer. We have created a reference deployer that allows you to deploy with minimal configuration, and allows you to easily override any resource configuration (e.g S3 bucket names, Lambda memory/timeouts, etc.). Deployments are managed by Terraform, and you can manage deployment state locally or via a number of backends (Terraform, AWS S3, etc.)

Alternatively, you can use this as a standalone builder and bring your own deployment logic.

## Limitations

* Lambda limitations apply: https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html.
* API Gateway limitations apply: https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html.
* The image handler only serves image optimization requests. It cannot redirect, rewrite or add headers (yet).
* The default and image handlers are separate, so you cannot rewrite from default routes -> image routes. This is by design since generally image optimization requests are only called by the Next.js image component, and also to improve performance so that image optimization code is not included in the default handler/lambda.

## Acknowledgments

Special thanks for Jan Varho for the initial prototype which this code is based on.
