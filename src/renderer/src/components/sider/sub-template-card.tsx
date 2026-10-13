import { Button, Card, CardBody, CardFooter, Spinner, Tooltip } from '@heroui/react'
import BorderSwitch from '@renderer/components/base/border-switch'
import React, { useState } from 'react'
import { LuLayoutTemplate } from 'react-icons/lu'
import { useLocation, useNavigate } from 'react-router-dom'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useSubTemplateConfig } from '@renderer/hooks/use-sub-template-config'
import { useTranslation } from 'react-i18next'

interface Props {
  iconOnly?: boolean
}

const SubTemplateCard: React.FC<Props> = (props) => {
  const { t } = useTranslation()
  const { appConfig } = useAppConfig()
  const { subTemplateConfig, patchSubTemplateConfig } = useSubTemplateConfig()
  const { iconOnly } = props
  const { subTemplateCardStatus = 'col-span-1', disableAnimations = false } = appConfig || {}
  const { enabled = false } = subTemplateConfig || {}
  const [applying, setApplying] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const match = location.pathname.includes('/sub-template')
  const {
    attributes,
    listeners,
    setNodeRef,
    transform: tf,
    transition,
    isDragging
  } = useSortable({
    id: 'subTemplate'
  })
  const transform = tf ? { x: tf.x, y: tf.y, scaleX: 1, scaleY: 1 } : null

  const onChange = async (value: boolean): Promise<void> => {
    if (applying) return
    setApplying(true)
    try {
      await patchSubTemplateConfig({ enabled: value })
    } finally {
      setApplying(false)
    }
  }

  if (iconOnly) {
    return (
      <div className={`${subTemplateCardStatus} flex justify-center`}>
        <Tooltip content={t('sider.cards.subTemplate')} placement="right">
          <Button
            size="sm"
            isIconOnly
            color={match ? 'primary' : 'default'}
            variant={match ? 'solid' : 'light'}
            onPress={() => {
              navigate('/sub-template')
            }}
          >
            <LuLayoutTemplate className="text-[20px]" />
          </Button>
        </Tooltip>
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'relative',
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 'calc(infinity)' : undefined
      }}
      className={`${subTemplateCardStatus} sub-template-card`}
    >
      <Card
        fullWidth
        ref={setNodeRef}
        {...attributes}
        {...listeners}
        className={`${match ? 'bg-primary' : 'hover:bg-primary/30'} ${disableAnimations ? '' : `motion-reduce:transition-transform-background ${isDragging ? 'scale-[0.95] tap-highlight-transparent' : ''}`}`}
      >
        <CardBody className="pb-1 pt-0 px-0">
          <div className="flex justify-between">
            <Button
              isIconOnly
              className="bg-transparent pointer-events-none"
              variant="flat"
              color="default"
            >
              <LuLayoutTemplate
                className={`${match ? 'text-primary-foreground' : 'text-foreground'} text-[24px]`}
              />
            </Button>
            <div className="flex items-center">
              {applying && <Spinner size="sm" color={match ? 'white' : 'primary'} />}
              <BorderSwitch
                isShowBorder={match && enabled}
                isSelected={enabled}
                isDisabled={applying || !subTemplateConfig}
                onValueChange={onChange}
              />
            </div>
          </div>
        </CardBody>
        <CardFooter className="pt-1">
          <h3
            className={`text-md font-bold sider-card-title ${match ? 'text-primary-foreground' : 'text-foreground'}`}
          >
            {t('sider.cards.subTemplate')}
          </h3>
        </CardFooter>
      </Card>
    </div>
  )
}

export default SubTemplateCard
