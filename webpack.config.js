import path from 'node:path';
import { fileURLToPath } from 'node:url';
import webpack from 'webpack';
import HtmlWebpackPlugin from 'html-webpack-plugin';
import MiniCssExtractPlugin from 'mini-css-extract-plugin';
import CopyWebpackPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default (_env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: './src/js/index.js',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProd ? 'assets/[name].[contenthash:8].js' : 'assets/[name].js',
      chunkFilename: isProd ? 'assets/[name].[contenthash:8].js' : 'assets/[name].js',
      clean: true,
      // 必须是绝对根路径：worker chunk 里的 importScripts() 相对 worker 自身位置
      // 解析，用相对 publicPath 会拼成 /assets/assets/... 直接 404。
      publicPath: '/',
    },
    resolve: {
      extensions: ['.js', '.json'],
      fallback: {
        fs: false,
        path: false,
        crypto: false,
        os: false,
      },
    },
    module: {
      rules: [
        {
          test: /\.css$/i,
          use: [MiniCssExtractPlugin.loader, 'css-loader'],
        },
        {
          test: /\.(png|jpe?g|gif|svg|woff2?|ttf|eot)$/i,
          type: 'asset/resource',
          generator: { filename: 'assets/media/[name][ext]' },
        },
        {
          // ONNX / WASM 二进制：as-is 拷进产物
          test: /\.(wasm|onnx)$/i,
          type: 'asset/resource',
          generator: { filename: 'assets/model/[name][ext]' },
        },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: './index.html',
        inject: 'body',
        scriptLoading: 'defer',
        minify: isProd
          ? { collapseWhitespace: true, removeComments: false, keepClosingSlash: true }
          : false,
      }),
      new MiniCssExtractPlugin({
        filename: isProd ? 'assets/[name].[contenthash:8].css' : 'assets/[name].css',
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: 'README.md', to: 'README.md', noErrorOnMissing: true },
          // 随站点发布的模型权重：存在就带上，站内模型加载完全离线可用
          {
            from: 'public/models',
            to: 'models',
            noErrorOnMissing: true,
            info: { minimized: true },
          },
        ],
      }),
      new webpack.DefinePlugin({
        __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
      }),
    ],
    devServer: {
      hot: false,
      liveReload: true,
      port: 8080,
      host: '0.0.0.0',
      allowedHosts: 'all',
      client: { overlay: { errors: true, warnings: false } },
      static: { directory: path.resolve(__dirname, 'public'), publicPath: '/' },
      headers: {
        // ONNX Runtime 多线程序列化需要这两个头
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    performance: { hints: false },
    optimization: {
      splitChunks: isProd
        ? { chunks: 'all', maxInitialRequests: 8, minSize: 30000 }
        : false,
    },
    experiments: {
      asyncWebAssembly: true,
      topLevelAwait: true,
    },
    devtool: isProd ? 'source-map' : 'eval-cheap-module-source-map',
    infrastructureLogging: { level: 'error' },
    stats: 'minimal',
  };
};
