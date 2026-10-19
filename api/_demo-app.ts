import { createDemoApp } from '../server/demo/create-demo-app.js'

/**
 * Shared Express app instance for every /api/* Vercel function.
 * Prefixed with `_` so Vercel's file-system router never exposes this
 * file itself as a route (Vercel excludes files/folders starting with `_`).
 * Each sibling route file under api/ re-exports this same instance;
 * Express does its own internal method/path routing from req.url, so it
 * does not matter which physical file Vercel invoked to reach it.
 */
const app = createDemoApp()

export default app
