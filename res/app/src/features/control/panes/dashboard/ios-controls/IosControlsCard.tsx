import {useState} from 'react'
import {Alert, Button, Stack, Text} from '@mantine/core'
import {IconDeviceMobileVibration} from '@tabler/icons-react'
import type {Control} from '@/core/control'
import {useTranslation} from '@/core/i18n'
import {WidgetCard} from '@/ui/WidgetCard'

export function IosControlsCard({control}: {control: Control}) {
  const {t} = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  async function shake() {
    setBusy(true)
    setError(false)
    try {
      await control.shake()
    }
    catch {
      setError(true)
    }
    finally {
      setBusy(false)
    }
  }
  return <WidgetCard title={t('iPhone controls')} icon={IconDeviceMobileVibration} color='blue'>
    <Stack gap='sm'>
      <Button variant='light' leftSection={<IconDeviceMobileVibration size={18} />}
        loading={busy} onClick={shake}>
        {t('Shake phone')}
      </Button>
      <Text size='xs' c='dimmed'>{t('Triggers the shake gesture used by application debug menus.')}</Text>
      {error && <Alert color='red'>
        {t('Could not shake the iPhone. Keep it unlocked and use the standard AssistiveTouch menu in English or Russian. Release and reconnect the device if the session ended.')}
      </Alert>}
    </Stack>
  </WidgetCard>
}
