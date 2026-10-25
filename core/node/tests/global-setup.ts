import { bootedTemplate } from './template.ts'

/** Makes the booted machine every session starts from once, before the test files run side by side */
export default function setup() {
  bootedTemplate()
}
