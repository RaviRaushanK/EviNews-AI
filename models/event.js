module.exports = (sequelize, DataTypes) => {
  const Event = sequelize.define('Event', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the event'
    },
    title: {
      type: DataTypes.STRING(500),
      allowNull: false,
      comment: 'Event title or headline'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Brief description of the event'
    },
    status: {
      type: DataTypes.ENUM('active', 'monitoring', 'resolved'),
      allowNull: false,
      defaultValue: 'active',
      comment: 'Current monitoring status'
    },
    event_date: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Date/time associated with the event'
    }
  }, {
    tableName: 'events',
    timestamps: true,
    underscored: false,
    comment: 'Clustered news events for analysis',
    indexes: [
      {
        name: 'idx_events_status',
        fields: ['status']
      },
      {
        name: 'idx_events_event_date',
        fields: ['event_date']
      }
    ]
  });

  Event.associate = (models) => {
    Event.belongsToMany(models.Article, {
      through: models.EventArticle,
      foreignKey: 'event_id',
      otherKey: 'article_id'
    });
    Event.hasMany(models.Claim, {
      foreignKey: 'event_id',
      onDelete: 'SET NULL',
      hooks: true
    });
    Event.hasMany(models.TimelineEvent, {
      foreignKey: 'event_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Event.hasMany(models.Summary, {
      foreignKey: 'event_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
  };

  return Event;
};