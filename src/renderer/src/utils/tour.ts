import { driver } from 'driver.js'
import { TFunction } from 'i18next'
import { NavigateFunction } from 'react-router-dom'

let driverInstance: ReturnType<typeof driver> | null = null

export function getDriver(): ReturnType<typeof driver> | null {
  return driverInstance
}

export function createTourDriver(t: TFunction, navigate: NavigateFunction): void {
  driverInstance = driver({
    showProgress: true,
    nextBtnText: t('common.next'),
    prevBtnText: t('common.prev'),
    doneBtnText: t('common.done'),
    progressText: '{{current}} / {{total}}',
    overlayOpacity: 0.9,
    steps: [
      {
        element: 'none',
        popover: {
          title: t('guide.welcome.title'),
          description: t('guide.welcome.description'),
          side: 'top',
          align: 'center'
        }
      },
      {
        element: '.side',
        popover: {
          title: t('guide.sider.title'),
          description: t('guide.sider.description'),
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '.sysproxy-card',
        popover: {
          title: t('guide.card.title'),
          description: t('guide.card.description'),
          side: 'right',
          align: 'start'
        }
      },
      {
        element: '.main',
        popover: {
          title: t('guide.main.title'),
          description: t('guide.main.description'),
          side: 'left',
          align: 'center'
        }
      },
      {
        element: '.profile-card',
        popover: {
          title: t('guide.profile.title'),
          description: t('guide.profile.description'),
          side: 'right',
          align: 'start',
          onNextClick: async (): Promise<void> => {
            navigate('/profiles')
            setTimeout(() => {
              driverInstance?.moveNext()
            }, 0)
          }
        }
      },
      {
        element: '.profiles-sticky',
        popover: {
          title: t('guide.import.title'),
          description: t('guide.import.description'),
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '.substore-import',
        popover: {
          title: t('guide.substore.title'),
          description: t('guide.substore.description'),
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '.new-profile',
        popover: {
          title: t('guide.localProfile.title'),
          description: t('guide.localProfile.description'),
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '.sysproxy-card',
        popover: {
          title: t('guide.sysproxy.title'),
          description: t('guide.sysproxy.description'),
          side: 'right',
          align: 'start',
          onNextClick: async (): Promise<void> => {
            navigate('/sysproxy')
            setTimeout(() => {
              driverInstance?.moveNext()
            }, 0)
          }
        }
      },
      {
        element: '.sysproxy-settings',
        popover: {
          title: t('guide.sysproxySetting.title'),
          description: t('guide.sysproxySetting.description'),
          side: 'top',
          align: 'start'
        }
      },
      {
        element: '.tun-card',
        popover: {
          title: t('guide.tun.title'),
          description: t('guide.tun.description'),
          side: 'right',
          align: 'start',
          onNextClick: async (): Promise<void> => {
            navigate('/tun')
            setTimeout(() => {
              driverInstance?.moveNext()
            }, 0)
          }
        }
      },
      {
        element: '.tun-settings',
        popover: {
          title: t('guide.tunSetting.title'),
          description: t('guide.tunSetting.description'),
          side: 'bottom',
          align: 'start'
        }
      },
      {
        element: '.override-card',
        popover: {
          title: t('guide.override.title'),
          description: t('guide.override.description'),
          side: 'right',
          align: 'center'
        }
      },
      {
        element: '.dns-card',
        popover: {
          title: t('guide.dns.title'),
          description: t('guide.dns.description'),
          side: 'right',
          align: 'center',
          onNextClick: async (): Promise<void> => {
            navigate('/profiles')
            setTimeout(() => {
              driverInstance?.moveNext()
            }, 0)
          }
        }
      },
      {
        element: 'none',
        popover: {
          title: t('guide.end.title'),
          description: t('guide.end.description'),
          side: 'top',
          align: 'center',
          onNextClick: async (): Promise<void> => {
            navigate('/profiles')
            setTimeout(() => {
              driverInstance?.destroy()
            }, 0)
          }
        }
      }
    ]
  })
}

export function startTourIfNeeded(): void {
  const tourShown = window.localStorage.getItem('tourShown')
  if (!tourShown && driverInstance) {
    window.localStorage.setItem('tourShown', 'true')
    driverInstance.drive()
  }
}
