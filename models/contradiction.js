module.exports = (sequelize, DataTypes) => {
  const Contradiction = sequelize.define('Contradiction', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the contradiction'
    },
    claim_id_1: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'First claim in the contradiction pair'
    },
    claim_id_2: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Second claim in the contradiction pair'
    },
    contradiction_type: {
      type: DataTypes.ENUM('direct', 'partial', 'temporal'),
      allowNull: false,
      defaultValue: 'direct',
      comment: 'Classification of the contradiction'
    },
    status: {
      type: DataTypes.ENUM('unresolved', 'resolved', 'under_review'),
      allowNull: false,
      defaultValue: 'unresolved',
      comment: 'Resolution status'
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Explanation of why the claims conflict'
    },
    detected_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      comment: 'When the contradiction was detected'
    }
  }, {
    tableName: 'contradictions',
    timestamps: true,
    underscored: false,
    comment: 'Detected contradictions between claims',
    hooks: {
      beforeValidate: (instance) => {
        if (instance.claim_id_1 && instance.claim_id_2) {
          if (instance.claim_id_1 === instance.claim_id_2) {
            throw new Error('Contradiction requires two different claims');
          }
          if (instance.claim_id_1 > instance.claim_id_2) {
            const first = instance.claim_id_1;
            instance.claim_id_1 = instance.claim_id_2;
            instance.claim_id_2 = first;
          }
        }
      }
    },
    indexes: [
      {
        name: 'idx_contradictions_claim_id_1',
        fields: ['claim_id_1']
      },
      {
        name: 'idx_contradictions_claim_id_2',
        fields: ['claim_id_2']
      },
      {
        name: 'idx_contradictions_unique',
        fields: ['claim_id_1', 'claim_id_2'],
        unique: true
      },
      {
        name: 'idx_contradictions_status',
        fields: ['status']
      }
    ],
    validate: {
      claimIdsOrdered() {
        if (this.claim_id_1 && this.claim_id_2 && this.claim_id_1 >= this.claim_id_2) {
          throw new Error('claim_id_1 must be less than claim_id_2');
        }
      }
    }
  });

  Contradiction.associate = (models) => {
    Contradiction.belongsTo(models.Claim, {
      foreignKey: 'claim_id_1',
      as: 'firstClaim',
      onDelete: 'RESTRICT',
      hooks: true
    });
    Contradiction.belongsTo(models.Claim, {
      foreignKey: 'claim_id_2',
      as: 'secondClaim',
      onDelete: 'RESTRICT',
      hooks: true
    });
  };

  return Contradiction;
};