import {useHotkeys} from '@mantine/hooks'
import {useNavigate} from 'react-router'
import type {Control} from '@/core/control'
import {usePlatform} from '@/ui/modes'
import type {DeviceActions} from './use-device-actions'

const allowInInputs = ['SELECT']

export function useControlHotkeys(control: Control, actions: DeviceActions, ios = false, readOnly = false) {
  const navigate = useNavigate()
  const [platform, setPlatform] = usePlatform()

  useHotkeys([
    ['meta+shift+D', () => navigate('/devices')]
    , ['shift+space', () => !readOnly && !ios && control.keyPress('switch_charset')]
    , ['meta+ArrowLeft', () => !readOnly && !ios && actions.rotateBy(-90)]
    , ['meta+ArrowRight', () => !readOnly && !ios && actions.rotateBy(90)]
    , ['meta+shift+M', () => !readOnly && !ios && control.menu()]
    , ['meta+shift+H', () => !readOnly && control.home()]
    , ['meta+shift+B', () => !readOnly && !ios && control.back()]
    , ['shift+W', () => setPlatform(platform === 'web' ? 'native' : 'web'), {preventDefault: false}]
  ], allowInInputs)
}
