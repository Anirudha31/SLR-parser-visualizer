import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  esbuild: {
    jsx: 'automatic', // or 'transform'
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
  },
})