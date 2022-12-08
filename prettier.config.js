module.exports = {
  printWidth: 80,
  tabWidth: 2,
  trailingComma: "all",
  singleQuote: false,
  semi: true,
  importOrder: [
    // node stdlib
    "^(path|fs|child_process)$",
    // sls
    "^@sls-next",
    // next/react/swr'
    "^(next|swr|react)(.*)$",
    // node_modules
    "<THIRD_PARTY_MODULES>",
    "^[./]"
  ],
  importOrderSeparation: true,
  importOrderSortSpecifiers: true
};
