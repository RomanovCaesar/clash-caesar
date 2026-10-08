import React from 'react'
import logo from '@renderer/assets/logo.png'

interface Props {
  className?: string
}

const AppLogo: React.FC<Props> = ({ className }) => {
  return <img src={logo} alt="Clash Caesar" draggable={false} className={className} />
}

export default AppLogo
