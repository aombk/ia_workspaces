import { setBackend } from '../backend'
import { createElectronBackend } from '../backend/electron'
import { start } from './app'

setBackend(createElectronBackend())
void start()
