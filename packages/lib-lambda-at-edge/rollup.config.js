import commonjs from "@rollup/plugin-commonjs";
import typescript from "rollup-plugin-typescript2";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import externals from "rollup-plugin-node-externals";
import json from "@rollup/plugin-json";
import { terser } from "rollup-plugin-terser";
import del from "rollup-plugin-delete";

const LOCAL_EXTERNALS = [
  "./manifest.json",
  "./api-manifest.json",
  "./routes-manifest.json",
  "./prerender-manifest.json",
  "./images-manifest.json"
];
const NPM_EXTERNALS = ["aws-lambda", "aws-sdk/clients/s3"];

const generateConfig = (input) => ({
  input: `./src/${input.filename}.ts`,
  output: {
    dir: `./dist/${input.filename}/${input.minify ? "minified" : "standard"}`,
    entryFileNames: `index.js`,
    format: "cjs"
  },
  plugins: [
    del({
      targets: `./dist/${input.filename}/${
        input.minify ? "minified" : "standard"
      }`
    }),
    json(),
    nodeResolve({
      preferBuiltins: true
    }),
    commonjs(),
    externals({
      exclude: [
        "@sls-next/next-aws-cloudfront",
        "@sls-next/core",
        "@sls-next/aws-common",
        "next"
      ]
    }),
    typescript({
      tsconfig: "tsconfig.bundle.json"
    }),
    input.minify
      ? terser({
          compress: true,
          mangle: true,
          output: { comments: false } // Remove all comments, which is fine as the handler code is not distributed.
        })
      : undefined
  ],
  external: [...NPM_EXTERNALS, ...LOCAL_EXTERNALS]
});

export default [
  { filename: "default-handler", minify: false },
  { filename: "default-handler", minify: true },
  { filename: "default-handler-v2", minify: false },
  { filename: "default-handler-v2", minify: true },
  { filename: "api-handler", minify: false },
  { filename: "api-handler", minify: true },
  { filename: "image-handler", minify: false },
  { filename: "image-handler", minify: true },
  { filename: "regeneration-handler", minify: false },
  { filename: "regeneration-handler", minify: true },
  { filename: "regeneration-handler-v2", minify: false },
  { filename: "regeneration-handler-v2", minify: true }
].map(generateConfig);
