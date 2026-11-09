# Подключение внешнего CI к ферме STF

Этот отдельный репозиторий демонстрирует подключение тестов Appium и Maestro к одной ферме. GitLab Runner создаёт временный pod рядом с устройствами; координатор выбирает телефон, ставит запрос в очередь и поддерживает бронь до окончания команды.

В CI проекта задаются переменные:

- `FARM_RUNNER_IMAGE`: утверждённый CI-образ, закреплённый по digest.
- `FARM_TOKEN_FILE`: masked file variable с проектным токеном координатора.
- `FARM_URL`: адрес координатора (в примере уже задан внутренний service URL).
- `FARM_TEST_IOS=true`: дополнительно включить Appium smoke на физическом iPhone.

Обычный pipeline запускает три задания при лимите координатора в два устройства. В STF можно смотреть экраны с фиолетовым статусом Automated; третье задание ожидает освобождения телефона. Appium сценарий держит устройство 25–45 секунд для наблюдения. Результаты JUnit и снимки сохраняются в артефактах каждого задания. Перед сценарием каждое задание проверяет отсутствие Kubernetes credentials и запрет прямого доступа к ADB, Grid и STF API; результат сохраняется в `artifacts/network-isolation.json`.

## Команда подключения

```sh
stf utils test run --runner appium --platform Android --run-id "$CI_PIPELINE_ID-$CI_JOB_ID" -- node tests/appium-settings.mjs
stf utils test run --runner maestro --platform Android --run-id "$CI_PIPELINE_ID-$CI_JOB_ID" -- bash tests/maestro-settings.sh
```

В тестовой команде доступен `STF_CONNECTION_FILE`. Appium получает URL локального прокси и W3C capabilities; Maestro — локальный ADB endpoint, содержащий только выделенный телефон. Тестовый код не использует токен STF, Kubernetes API, общий ADB server или Appium Grid напрямую.

Обёртка отвечает за ожидание устройства, heartbeat и освобождение; тест отвечает за сценарий и отчёт. Нельзя одновременно включать дополнительную фабрику, которая самостоятельно получает вторую бронь.

Физический Android работает с обоими движками. Для физических iPhone используется Appium; Maestro iOS требует отдельного пула симуляторов macOS.

Текущие iOS-ноды подключаются к уже запущенному WDA на Linux. При создании сессии сохраняйте `appium:autoLaunch=false`, не задавайте `appium:bundleId`/`appium:app`; после подключения вызовите `activateApp` для установленного приложения. Установка и обновление iOS-приложения в этот прототип подключения не входят.

## Изоляция

Runner привязан только к этому проекту, запускает задания с тегом `stf-farm`, не принимает untagged jobs. У job pod нет Kubernetes credentials, privileged режима и доступа к USB/host filesystem. Сетевой доступ ограничен DNS, GitLab и API координатора. Закрытие/отмена worker не позволяет следующему тесту получить телефон до проверки очистки координатором.
